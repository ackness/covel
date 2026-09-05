import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  createMemoryStore,
  exportSessionCheckpoint,
  type BrowserCheckpoint,
  type DataStore,
} from "@covel/store";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { createBrowserWorkspaceRoutes } from "../../src/routes/api/browser-workspace.js";
import { hashSessionOwnerToken } from "../../src/routes/api/session/session-guard.js";

const SESSION_ID = "browser-session";
const WORLD_ID = "shared-world";
const OWNER = "synthetic-browser-owner";
const OPERATOR = "synthetic-browser-operator";
const NOW = "2026-08-25T00:00:00.000Z";
let store: DataStore;
let app: Hono;
let checkpoint: BrowserCheckpoint;
let lock: ReturnType<typeof createInProcessSessionLock>;
let onLock: (() => void) | undefined;

async function seedSession(owner = OWNER, incarnation = "original") {
  await store.createSession({
    id: SESSION_ID,
    worldId: WORLD_ID,
    phase: "playing",
    status: "active",
    completedPlayerTurns: 0,
    setupRuntimes: {},
    activePlugins: [],
    locale: "zh-CN",
    metadata: {
      ownerTokenHash: hashSessionOwnerToken(owner),
      sessionIncarnationNonce: incarnation,
    },
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function upload(value: unknown = checkpoint, token = OWNER) {
  return app.request(`/api/sessions/${SESSION_ID}/browser-checkpoint`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-session-token": token },
    body: JSON.stringify({ checkpoint: value }),
  });
}

function commit(token = OWNER) {
  return app.request(`/api/sessions/${SESSION_ID}/browser-commit`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-session-token": token },
    body: JSON.stringify({ actionId: "turn-1", baseRevision: 1 }),
  });
}

beforeEach(async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("DEPLOYMENT_TIER", "self");
  vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", OPERATOR);
  store = createMemoryStore();
  await store.upsertWorld({
    id: WORLD_ID,
    name: "Shared World",
    description: "Original world",
    createdAt: NOW,
  });
  await seedSession();
  // A browser has public session metadata only.
  const source = createMemoryStore();
  await source.upsertWorld((await store.getWorld(WORLD_ID))!);
  await source.createSession({
    ...(await store.getSession(SESSION_ID))!,
    metadata: {},
  });
  checkpoint = await exportSessionCheckpoint(source, SESSION_ID, {
    revision: 1,
    actionId: "bootstrap",
  });
  lock = createInProcessSessionLock();
  onLock = undefined;
  app = new Hono();
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("storeBackend", "memory");
    c.set("sessionLock", {
      ...lock,
      withLock: (id, fn) => {
        onLock?.();
        return lock.withLock(id, fn);
      },
    });
    await next();
  });
  app.route("/api/sessions", createBrowserWorkspaceRoutes());
});

afterEach(() => vi.unstubAllEnvs());

describe("browser checkpoint security", () => {
  it.each(["self", "demo", "commercial"])(
    "preserves the server's shared world during ordinary sync on %s",
    async (tier) => {
      vi.stubEnv("DEPLOYMENT_TIER", tier);
      const world = await store.getWorld(WORLD_ID);
      const edited = {
        ...checkpoint,
        world: { ...checkpoint.world!, name: "Tampered" },
      };
      const response = await upload(edited);
      expect(response.status).toBe(200);
      expect(await store.getWorld(WORLD_ID)).toEqual(world);
      expect((await upload()).status).toBe(200);
      const committed = await commit();
      expect(committed.status).toBe(200);
      expect(await committed.json()).toMatchObject({
        checkpoint: { world: JSON.parse(JSON.stringify(world)) },
      });
    },
  );

  it("allows explicitly authenticated operator world updates", async () => {
    const edited = {
      ...checkpoint,
      world: { ...checkpoint.world!, name: "Approved" },
    };
    expect((await upload(edited, OPERATOR)).status).toBe(200);
    expect((await store.getWorld(WORLD_ID))?.name).toBe("Approved");
  });

  it("accepts normal recovery after seed timestamps and derived metadata change", async () => {
    const reseeded = {
      ...checkpoint.world!,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      metadata: {
        worldData: { sources: [{ importedAt: "2026-09-01T00:00:00.000Z" }] },
      },
    };
    await store.upsertWorld(reseeded);
    expect((await upload()).status).toBe(200);
    expect(await store.getWorld(WORLD_ID)).toEqual(reseeded);
  });

  it("requires an operator to introduce a new global world", async () => {
    const edited = {
      ...checkpoint,
      session: { ...checkpoint.session, worldId: "new-world" },
      world: { ...checkpoint.world!, id: "new-world" },
    };
    expect((await upload(edited)).status).toBe(401);
    expect(await store.getWorld("new-world")).toBeNull();
    expect((await store.getSession(SESSION_ID))?.worldId).toBe(WORLD_ID);
  });

  it("rejects foreign plugin data before writing either session", async () => {
    const record = {
      id: "foreign-data",
      sessionId: "other-session",
      pluginId: "test-plugin",
      namespace: "test",
      key: "value",
      value: "original",
      createdAt: NOW,
      updatedAt: NOW,
    };
    await store.setPluginData(record);
    const response = await upload({
      ...checkpoint,
      pluginData: [{ ...record, value: "tampered" }],
    });
    expect(response.status).toBe(400);
    expect(await store.listPluginDataSessionScope("other-session")).toEqual([
      record,
    ]);
  });

  it("preserves the server's immutable session identity", async () => {
    expect(
      (
        await upload({
          ...checkpoint,
          session: {
            ...checkpoint.session,
            createdAt: "2026-09-01T00:00:00.000Z",
            metadata: {
              sessionIncarnationNonce: "forged",
              approvalScopeNonce: "forged",
            },
          },
        })
      ).status,
    ).toBe(200);
    const session = await store.getSession(SESSION_ID);
    expect(session?.createdAt).toBe(NOW);
    expect(session?.metadata?.sessionIncarnationNonce).toBe("original");
    expect(session?.metadata?.approvalScopeNonce).toBeUndefined();
  });

  it("rejects a foreign global record ID and rolls back the checkpoint", async () => {
    const foreign = {
      id: "shared-ledger-id",
      sessionId: "other-session",
      target: "pluginData",
      sourceWorldId: WORLD_ID,
      sourceId: "source",
      sourceDigest: "digest",
      valueHash: "hash",
      importedAt: NOW,
      managed: true,
    };
    await store.saveWorldDataImportLedgerBatch([foreign]);
    const originalMessage = {
      id: "original-message",
      sessionId: SESSION_ID,
      role: "user",
      content: "preserve on failure",
      createdAt: NOW,
    };
    await store.addMessage(originalMessage);
    const response = await upload({
      ...checkpoint,
      worldDataLedger: [{ ...foreign, sessionId: SESSION_ID }],
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "session_record_scope_conflict",
    });
    expect(await store.listWorldDataImportLedger("other-session")).toEqual([
      foreign,
    ]);
    expect(await store.listMessages(SESSION_ID)).toEqual([originalMessage]);
    expect((await upload()).status).toBe(200);
  });
});

describe("browser workspace session lock", () => {
  it.each(["upload", "unchanged", "commit", "cached"] as const)(
    "rechecks ownership before a queued %s can access a replacement session",
    async (operation) => {
      if (operation !== "upload") expect((await upload()).status).toBe(200);
      if (operation === "cached") expect((await commit()).status).toBe(200);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const blocker = lock.withLock(SESSION_ID, async () => {
        entered.resolve();
        await release.promise;
        await store.deleteSession(SESSION_ID);
        await seedSession("new-owner", "replacement");
        await store.addMessage({
          id: "new-message",
          sessionId: SESSION_ID,
          role: "user",
          content: "replacement data",
          createdAt: NOW,
        });
      });
      await entered.promise;
      const queued = Promise.withResolvers<void>();
      onLock = queued.resolve;
      const pending =
        operation === "upload" || operation === "unchanged"
          ? upload()
          : commit();
      await queued.promise;
      release.resolve();
      await blocker;
      const response = await pending;
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        code: "session_owner_required",
      });
      expect((await store.listMessages(SESSION_ID))[0]?.content).toBe(
        "replacement data",
      );
    },
  );

  it.each(["upload", "commit"] as const)(
    "rejects a stale %s even when the recreated session has the same owner",
    async (operation) => {
      expect((await upload()).status).toBe(200);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const blocker = lock.withLock(SESSION_ID, async () => {
        entered.resolve();
        await release.promise;
        await store.deleteSession(SESSION_ID);
        await seedSession(OWNER, "replacement");
      });
      await entered.promise;
      const queued = Promise.withResolvers<void>();
      onLock = queued.resolve;
      const pending = operation === "upload" ? upload() : commit();
      await queued.promise;
      release.resolve();
      await blocker;
      const response = await pending;
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "session_incarnation_changed",
      });
    },
  );

  it("discards cached commits and revision heads after same-id recreation", async () => {
    expect((await upload()).status).toBe(200);
    expect((await commit()).status).toBe(200);
    await store.deleteSession(SESSION_ID);
    await seedSession("new-owner", "replacement");
    const response = await commit("new-owner");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "browser_checkpoint_required",
    });
    expect((await upload(checkpoint, "new-owner")).status).toBe(200);
  });

  it.each(["upload", "commit"] as const)(
    "refuses %s while deletion is pending, including cached responses",
    async (operation) => {
      expect((await upload()).status).toBe(200);
      expect((await commit()).status).toBe(200);
      await store.updateSession(SESSION_ID, {
        metadata: { deletionPendingNonce: "pending-delete" },
      });
      const response = await (operation === "upload" ? upload() : commit());
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "session_deleting" });
    },
  );
});
