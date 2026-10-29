import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { Hono } from "hono";
import {
  exportSessionCheckpoint,
  type BrowserCheckpoint,
  type DataStore,
  type SessionCommit,
} from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { createBrowserWorkspaceRoutes } from "../../src/routes/api/browser-workspace.js";

const SESSION_ID = "browser-session";
const WORLD_ID = "browser-world";

let store: DataStore;
let app: Hono;
let clearSlots: Mock<(sessionId: string) => void>;
let invalidateSlots: Mock<(sessionId: string) => void>;

async function seed(target: DataStore, metadata?: Record<string, unknown>) {
  await target.upsertWorld({
    id: WORLD_ID,
    name: "Browser World",
    description: "",
    createdAt: "2026-08-25T00:00:00.000Z",
  });
  await target.createSession({
    phase: "playing",
    setupRuntimes: {},
    seats: [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
    id: SESSION_ID,
    worldId: WORLD_ID,
    status: "active",
    completedPlayerTurns: 0,

    activePlugins: [],
    locale: "zh-CN",
    metadata: { ...metadata, sessionIncarnationNonce: crypto.randomUUID() },
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
  });
}

async function upload(checkpoint: unknown): Promise<Response> {
  return app.request(`/api/sessions/${SESSION_ID}/browser-checkpoint`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ checkpoint }),
  });
}

async function commit(
  actionId: string,
  baseRevision: number,
): Promise<Response> {
  return app.request(`/api/sessions/${SESSION_ID}/browser-commit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actionId, baseRevision }),
  });
}

beforeEach(async () => {
  store = createMemoryStore();
  await seed(store, { ownerTokenHash: "server-private" });
  clearSlots = vi.fn();
  invalidateSlots = vi.fn();
  app = new Hono();
  app.use("*", async (c, next) => {
    c.set("uiSlots", {
      get: async () => [],
      clearSession: clearSlots,
      invalidateSession: invalidateSlots,
      close: async () => {},
    });
    c.set("store", store);
    c.set("storeBackend", "memory");
    c.set("sessionLock", createInProcessSessionLock());
    await next();
  });
  app.route("/api/sessions", createBrowserWorkspaceRoutes());
});

describe("browser-private workspace exchange", () => {
  async function initializeServerSession() {
    await store.updateSession(SESSION_ID, {
      activePlugins: ["consumer", "provider"],
    });
    await store.setPluginData({
      id: "initial-item",
      sessionId: SESSION_ID,
      pluginId: "provider",
      namespace: "items",
      key: "radio",
      value: { quantity: 1 },
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:00.000Z",
    });
  }

  it("exports the server's initialization as a new save's revision 1", async () => {
    await initializeServerSession();
    const requestFirst = () => commit(`local:create:${SESSION_ID}`, 0);

    const response = await requestFirst();
    expect(response.status).toBe(200);
    const first = (await response.json()) as SessionCommit;
    expect(first).toMatchObject({ baseRevision: 0, revision: 1 });
    expect(first.checkpoint.session.activePlugins).toEqual([
      "consumer",
      "provider",
    ]);
    expect(first.checkpoint.pluginData).toContainEqual(
      expect.objectContaining({ key: "radio", value: { quantity: 1 } }),
    );
    expect(first.checkpoint.session.metadata).not.toHaveProperty(
      "ownerTokenHash",
    );
    // A lost reply retries with the same action and gets the same commit.
    expect(await (await requestFirst()).json()).toEqual(first);
    // Uploading that save back is the same head, not a replacement.
    expect(await (await upload(first.checkpoint)).json()).toMatchObject({
      ok: true,
      revision: 1,
      unchanged: true,
    });
  });

  it("refuses a first export that is not a new save's", async () => {
    await initializeServerSession();
    const refused = async (actionId: string, baseRevision: number) => {
      const response = await commit(actionId, baseRevision);
      expect(response.status).toBe(409);
      return response.json();
    };
    expect(await refused("turn-1", 0)).toMatchObject({
      code: "browser_checkpoint_required",
    });
    expect(await refused(`local:create:${SESSION_ID}`, 1)).toMatchObject({
      code: "browser_checkpoint_required",
    });
    await store.updateSession(SESSION_ID, { completedPlayerTurns: 1 });
    expect(await refused(`local:create:${SESSION_ID}`, 0)).toMatchObject({
      code: "browser_checkpoint_required",
    });
  });

  it("restores a revision-1 save whole, even with the initial action", async () => {
    await initializeServerSession();
    const browser = createMemoryStore();
    await seed(browser);
    const save = await exportSessionCheckpoint(browser, SESSION_ID, {
      revision: 1,
      actionId: `local:create:${SESSION_ID}`,
    });

    expect(await (await upload(save)).json()).toEqual({
      ok: true,
      revision: 1,
    });
    expect((await store.getSession(SESSION_ID))?.activePlugins).toEqual([]);
    expect(await store.listPluginDataSessionScope(SESSION_ID)).toEqual([]);
    // With a head in place, the initial action can no longer export.
    expect((await commit(`local:create:${SESSION_ID}`, 0)).status).toBe(409);
  });

  async function queuedCheckpoint(): Promise<BrowserCheckpoint> {
    const browser = createMemoryStore();
    await seed(browser);
    await browser.setPluginData({
      id: "durable-job",
      sessionId: SESSION_ID,
      pluginId: "media",
      namespace: "_runtime_jobs",
      key: "job-1",
      value: { status: "queued", updatedAt: "initial", attempt: 0 },
      createdAt: "2026-08-25T00:00:01.000Z",
      updatedAt: "2026-08-25T00:00:01.000Z",
    });
    const checkpoint = await exportSessionCheckpoint(browser, SESSION_ID, {
      revision: 1,
      actionId: "queued-turn",
    });
    expect((await upload(checkpoint)).status).toBe(200);
    return checkpoint;
  }

  it.each(["running", "succeeded"])(
    "preserves a %s job, detached output and browser edits during the next upload",
    async (status) => {
      const checkpoint = await queuedCheckpoint();
      const job = (await store.listPluginDataSessionScope(SESSION_ID))[0]!;
      await store.setPluginData({
        ...job,
        value: { status, updatedAt: "advanced", ownerId: "live-worker" },
      });
      await store.setPluginData({
        ...job,
        id: "result-row",
        namespace: "results",
        key: "output",
        value: { url: "synthetic-result" },
      });
      const next = {
        ...checkpoint,
        revision: 2,
        actionId: "local-input",
        session: {
          ...checkpoint.session,
          status: "paused" as const,
          runtimeModelOverrides: { "media/render": "synthetic-slot" },
        },
        world: { ...checkpoint.world!, name: "Edited World" },
        messages: [
          {
            id: "next-input",
            sessionId: SESSION_ID,
            role: "user" as const,
            content: "Continue",
            createdAt: "2026-08-25T00:00:02.000Z",
          },
        ],
      };
      const response = await upload(next);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ reconcileRequired: true });
      const rows = await store.listPluginDataSessionScope(SESSION_ID);
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.key === "job-1")?.value).toMatchObject({
        status,
        ownerId: "live-worker",
      });
      expect((await store.getSession(SESSION_ID))?.status).toBe("paused");
      expect(
        (await store.getSession(SESSION_ID))?.runtimeModelOverrides,
      ).toEqual({
        "media/render": "synthetic-slot",
      });
      expect((await store.getWorld(WORLD_ID))?.name).toBe("Edited World");
      expect(
        (await store.listMessages(SESSION_ID)).map((row) => row.id),
      ).toEqual(["next-input"]);
      // Retrying a lost upload reply still directs the browser to reconciliation.
      expect(await (await upload(next)).json()).toMatchObject({
        unchanged: true,
        reconcileRequired: true,
      });
      expect(await store.listMessages(SESSION_ID)).toHaveLength(1);
      const requestCommit = () => commit("hydrate:2", 2);
      const committed = await (await requestCommit()).json();
      expect(committed).toMatchObject({
        revision: 3,
        checkpoint: {
          pluginData: expect.arrayContaining([
            expect.objectContaining({ namespace: "results" }),
          ]),
        },
      });
      // Retrying a lost commit reply returns exactly the same checkpoint.
      expect(await (await requestCommit()).json()).toEqual(committed);
    },
  );

  it.each(["worldId", "locale", "activePlugins", "pluginData", "messages"])(
    "rejects unsupported browser %s edits without dropping detached results",
    async (field) => {
      const checkpoint = await queuedCheckpoint();
      const next = { ...checkpoint, revision: 2, actionId: "unsupported" };
      if (field === "pluginData") next.pluginData = [];
      else if (field === "messages")
        next.messages = [
          {
            id: "forged-result",
            sessionId: SESSION_ID,
            role: "assistant",
            content: "Changed",
            createdAt: "2026-08-25T00:00:03.000Z",
          },
        ];
      else
        next.session = {
          ...checkpoint.session,
          ...(field === "worldId" ? { worldId: "other-world" } : {}),
          ...(field === "locale" ? { locale: "en-US" } : {}),
          ...(field === "activePlugins"
            ? { activePlugins: ["other-plugin"] }
            : {}),
        };
      if (field === "worldId")
        next.world = { ...checkpoint.world!, id: "other-world" };
      const response = await upload(next);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "unsupported_browser_mutation",
      });
      expect(await store.listPluginDataSessionScope(SESSION_ID)).toHaveLength(
        1,
      );
    },
  );

  it("rejects a new local input that collides with a newly committed server message", async () => {
    const checkpoint = await queuedCheckpoint();
    const message = {
      id: "same-id",
      sessionId: SESSION_ID,
      role: "user" as const,
      content: "Server content",
      createdAt: "2026-08-25T00:00:03.000Z",
    };
    await store.addMessage(message);
    const response = await upload({
      ...checkpoint,
      revision: 2,
      actionId: "collision",
      messages: [{ ...message, content: "Different browser content" }],
    });
    expect(response.status).toBe(409);
    expect((await store.listMessages(SESSION_ID))[0]?.content).toBe(
      "Server content",
    );
  });
  it("hydrates all checkpoint domains and preserves server-private metadata", async () => {
    const nonce = (await store.getSession(SESSION_ID))?.metadata
      ?.sessionIncarnationNonce;
    const browser = createMemoryStore();
    await seed(browser, { player: "local" });
    await browser.addMessage({
      id: "message-1",
      sessionId: SESSION_ID,
      role: "user",
      content: "hello",
      createdAt: "2026-08-25T00:00:01.000Z",
    });
    const checkpoint = await exportSessionCheckpoint(browser, SESSION_ID, {
      revision: 1,
      actionId: "bootstrap",
    });

    expect((await upload(checkpoint)).status).toBe(200);
    expect(clearSlots).toHaveBeenCalledWith(SESSION_ID);
    expect(invalidateSlots).toHaveBeenCalledWith(SESSION_ID);
    expect((await store.listMessages(SESSION_ID))[0]?.content).toBe("hello");
    expect((await store.getSession(SESSION_ID))?.metadata).toEqual({
      player: "local",
      ownerTokenHash: "server-private",
      sessionIncarnationNonce: nonce,
    });
  });

  it("keeps the browser's plugin selection when a rebuilt server session differs", async () => {
    // After a restart the browser recreates the server session from its
    // resolved plugin list, so the server's public metadata no longer matches
    // what the player chose. The browser save is authoritative for it.
    store = createMemoryStore();
    await seed(store, {
      ownerTokenHash: "server-private",
      pluginSelection: { requested: ["story", "dependency"], excluded: [] },
      loreOverride: "server copy",
    });
    const nonce = (await store.getSession(SESSION_ID))?.metadata
      ?.sessionIncarnationNonce;
    const browser = createMemoryStore();
    await seed(browser, {
      pluginSelection: { requested: ["story"], excluded: ["extra"] },
    });
    const checkpoint = await exportSessionCheckpoint(browser, SESSION_ID, {
      revision: 3,
      actionId: "turn-2",
    });

    expect((await upload(checkpoint)).status).toBe(200);
    expect((await store.getSession(SESSION_ID))?.metadata).toEqual({
      pluginSelection: { requested: ["story"], excluded: ["extra"] },
      ownerTokenHash: "server-private",
      sessionIncarnationNonce: nonce,
    });
  });

  it("returns an idempotent post-action commit and advances revision once", async () => {
    const browser = createMemoryStore();
    await seed(browser);
    const checkpoint = await exportSessionCheckpoint(browser, SESSION_ID, {
      revision: 1,
      actionId: "bootstrap",
    });
    expect((await upload(checkpoint)).status).toBe(200);
    await store.addMessage({
      id: "message-2",
      sessionId: SESSION_ID,
      role: "assistant",
      content: "world",
      createdAt: "2026-08-25T00:00:02.000Z",
    });

    const request = () => commit("turn-1", 1);
    const first = await request();
    const firstCommit = (await first.json()) as SessionCommit;
    const replay = await request();
    const replayCommit = (await replay.json()) as SessionCommit;

    expect(first.status).toBe(200);
    expect(firstCommit.revision).toBe(2);
    expect(firstCommit.checkpoint.messages).toHaveLength(1);
    expect(replayCommit).toEqual(firstCommit);
  });

  it("rejects a stale browser upload", async () => {
    const browser = createMemoryStore();
    await seed(browser);
    const first = await exportSessionCheckpoint(browser, SESSION_ID, {
      revision: 2,
      actionId: "local-2",
    });
    expect((await upload(first)).status).toBe(200);
    const stale = { ...first, revision: 1, actionId: "local-1" };
    expect((await upload(stale)).status).toBe(409);
  });

  it("rejects a different checkpoint head at the same revision", async () => {
    const browser = createMemoryStore();
    await seed(browser);
    const first = await exportSessionCheckpoint(browser, SESSION_ID, {
      revision: 1,
      actionId: "local-a",
    });
    expect((await upload(first)).status).toBe(200);

    expect((await upload({ ...first, actionId: "local-b" })).status).toBe(409);
  });

  it("rejects path-like checkpoint locales before persisting them", async () => {
    const browser = createMemoryStore();
    await seed(browser);
    const checkpoint = await exportSessionCheckpoint(browser, SESSION_ID, {
      revision: 1,
      actionId: "unsafe-locale",
    });

    const response = await upload({
      ...checkpoint,
      session: { ...checkpoint.session, locale: "x/../../../README" },
    });

    expect(response.status).toBe(400);
    expect((await store.getSession(SESSION_ID))?.locale).toBe("zh-CN");
  });

  it("canonicalizes checkpoint session locales", async () => {
    const browser = createMemoryStore();
    await seed(browser);
    const checkpoint = await exportSessionCheckpoint(browser, SESSION_ID, {
      revision: 1,
      actionId: "canonical-locale",
    });

    expect(
      (
        await upload({
          ...checkpoint,
          session: { ...checkpoint.session, locale: " ru_ru " },
        })
      ).status,
    ).toBe(200);
    expect((await store.getSession(SESSION_ID))?.locale).toBe("ru-RU");
  });
});

describe("browser checkpoint world provenance", () => {
  it("accepts a save when the server keeps its edited world with absent fields", async () => {
    // A package-built record can hold `undefined` for an absent manifest field;
    // MemoryStore keeps it as is, while JSON-backed stores drop it.
    await store.upsertWorld({
      id: WORLD_ID,
      name: "Browser World",
      description: "",
      metadata: { packageModified: true, worldDataPath: undefined },
      createdAt: "2026-08-25T00:00:00.000Z",
    });
    const browser = createMemoryStore();
    await seed(browser);
    const checkpoint = await exportSessionCheckpoint(browser, SESSION_ID, {
      revision: 2,
      actionId: "local-edit",
    });

    const response = await upload(checkpoint);

    expect(response.status).toBe(200);
  });
});
