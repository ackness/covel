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
import {
  hashSessionOwnerToken,
  publicSessionMetadata,
} from "../../src/routes/api/session/session-guard.js";

const SESSION_ID = "isolated-browser-session";
const WORLD_ID = "shared-world";
let store: DataStore;
let app: Hono;
let sessionLock: ReturnType<typeof createInProcessSessionLock>;

async function seed(
  owner = "owner-a",
  incarnation = "incarnation-a",
  worldId = WORLD_ID,
) {
  await store.createSession({
    id: SESSION_ID,
    worldId,
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
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
  });
}

function request(
  route: "browser-checkpoint" | "browser-commit",
  body: unknown,
  owner = "owner-a",
): Promise<Response> {
  return app.request(`/api/sessions/${SESSION_ID}/${route}`, {
    method: route === "browser-checkpoint" ? "PUT" : "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${owner}`,
    },
    body: JSON.stringify(body),
  });
}

async function checkpoint(): Promise<BrowserCheckpoint> {
  const exported = await exportSessionCheckpoint(store, SESSION_ID, {
    revision: 1,
    actionId: "bootstrap",
  });
  return {
    ...exported,
    session: {
      ...exported.session,
      metadata: publicSessionMetadata(exported.session.metadata),
    },
  };
}

beforeEach(async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("DEPLOYMENT_TIER", "self");
  store = createMemoryStore();
  sessionLock = createInProcessSessionLock();
  await store.upsertWorld({
    id: WORLD_ID,
    name: "Shared World",
    description: "Original world",
    createdAt: "2026-08-25T00:00:00.000Z",
  });
  await seed();
  app = new Hono();
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("storeBackend", "memory");
    c.set("sessionLock", sessionLock);
    await next();
  });
  app.route("/api/sessions", createBrowserWorkspaceRoutes());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("browser workspace session isolation", () => {
  it("does not expose a cached commit to a new owner after same-id recreation", async () => {
    expect(
      (await request("browser-checkpoint", { checkpoint: await checkpoint() }))
        .status,
    ).toBe(200);
    await store.addMessage({
      id: "private-message",
      sessionId: SESSION_ID,
      role: "user",
      content: "old-owner-private-content",
      createdAt: "2026-08-25T00:00:01.000Z",
    });
    const commitBody = { actionId: "turn-1", baseRevision: 1 };
    expect((await request("browser-commit", commitBody)).status).toBe(200);

    await store.deleteSession(SESSION_ID);
    await seed("owner-b", "incarnation-b");
    const response = await request("browser-commit", commitBody, "owner-b");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "browser_checkpoint_required",
    });
    const fresh = { ...(await checkpoint()), revision: 1, actionId: "fresh" };
    expect(
      (await request("browser-checkpoint", { checkpoint: fresh }, "owner-b"))
        .status,
    ).toBe(200);
    const committed = await request(
      "browser-commit",
      { actionId: "turn-1", baseRevision: 1 },
      "owner-b",
    );
    expect(committed.status).toBe(200);
    expect(await committed.json()).toMatchObject({
      checkpoint: { messages: [] },
    });
  });

  it("imports an identical revision/action head for a replacement incarnation", async () => {
    const initial = await checkpoint();
    expect(
      (await request("browser-checkpoint", { checkpoint: initial })).status,
    ).toBe(200);
    await store.deleteSession(SESSION_ID);
    await seed("owner-b", "incarnation-b");
    const next = {
      ...(await checkpoint()),
      messages: [
        {
          id: "new-message",
          sessionId: SESSION_ID,
          role: "user" as const,
          content: "new-owner-content",
          createdAt: "2026-08-25T00:00:01.000Z",
        },
      ],
    };
    const response = await request(
      "browser-checkpoint",
      { checkpoint: next },
      "owner-b",
    );
    expect(response.status).toBe(200);
    expect((await store.listMessages(SESSION_ID))[0]?.content).toBe(
      "new-owner-content",
    );
  });

  describe.each(["browser-checkpoint", "browser-commit"] as const)(
    "%s commit barrier",
    (route) => {
      it.each([
        { change: "owner", status: 401, code: "session_owner_required" },
        {
          change: "incarnation",
          status: 409,
          code: "session_incarnation_changed",
        },
        { change: "delete", status: 404, code: "session_not_found" },
        { change: "deleting", status: 409, code: "session_deleting" },
      ])("revalidates $change while waiting for the lock", async (scenario) => {
        const initial = await checkpoint();
        expect(
          (await request("browser-checkpoint", { checkpoint: initial })).status,
        ).toBe(200);
        const commitBody = { actionId: "turn-1", baseRevision: 1 };
        expect((await request("browser-commit", commitBody)).status).toBe(200);

        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const holder = sessionLock.withLock(SESSION_ID, async () => {
          entered.resolve();
          await release.promise;
          if (scenario.change === "delete") {
            await store.deleteSession(SESSION_ID);
          } else if (scenario.change === "owner") {
            await store.updateSession(SESSION_ID, {
              metadata: { ownerTokenHash: hashSessionOwnerToken("owner-b") },
            });
          } else if (scenario.change === "incarnation") {
            await store.deleteSession(SESSION_ID);
            await seed("owner-a", "incarnation-b");
          } else {
            await store.updateSession(SESSION_ID, {
              metadata: { deletionPendingNonce: "delete-in-progress" },
            });
          }
        });
        await entered.promise;

        const queued = Promise.withResolvers<void>();
        const withLock = sessionLock.withLock.bind(sessionLock);
        vi.spyOn(sessionLock, "withLock").mockImplementation((id, fn) => {
          queued.resolve();
          return withLock(id, fn);
        });
        const pending = request(
          route,
          route === "browser-checkpoint"
            ? { checkpoint: { ...initial, revision: 3, actionId: "next" } }
            : commitBody,
        );
        await queued.promise;
        release.resolve();
        await holder;
        const response = await pending;
        expect(response.status).toBe(scenario.status);
        expect(await response.json()).toMatchObject({ code: scenario.code });
      });
    },
  );
});

describe("browser checkpoint world authorization", () => {
  beforeEach(async () => {
    vi.stubEnv("DEPLOYMENT_TIER", "demo");
    vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "operator-token");
    await store.upsertWorld({
      id: "shared-world",
      name: "Shared World",
      description: "Original world",
      createdAt: "2026-08-25T00:00:00.000Z",
    });
    await store.deleteSession(SESSION_ID);
    await seed("owner-a", "incarnation-a", "shared-world");
    const session = (await store.getSession(SESSION_ID))!;
    await store.createSession({ ...session, id: "other-session" });
    await store.addMessage({
      id: "existing-message",
      sessionId: SESSION_ID,
      role: "user",
      content: "Keep this message on denial",
      createdAt: "2026-08-25T00:00:01.000Z",
    });
  });

  it.each(["included", "omitted"])(
    "rejects an unknown world with %s world content before any checkpoint writes",
    async (world) => {
      const before = await checkpoint();
      const originalSession = await store.getSession(SESSION_ID);
      const altered = {
        ...before,
        messages: [],
        session: {
          ...before.session,
          worldId: "other-world",
        },
        world:
          world === "included" ? { ...before.world!, id: "other-world" } : null,
      };
      const response = await request("browser-checkpoint", {
        checkpoint: altered,
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        code: "operator_token_required",
      });
      expect(await store.getSession(SESSION_ID)).toEqual(originalSession);
      expect(await store.listMessages(SESSION_ID)).toEqual(before.messages);
      expect(await store.getWorld("shared-world")).toEqual(before.world);
      expect(await store.getWorld("other-world")).toBeNull();
      expect((await store.getSession("other-session"))?.worldId).toBe(
        "shared-world",
      );
    },
  );

  it("rejects mismatched world scope before any checkpoint writes", async () => {
    const before = await checkpoint();
    const originalSession = await store.getSession(SESSION_ID);
    const response = await request("browser-checkpoint", {
      checkpoint: {
        ...before,
        messages: [],
        world: { ...before.world!, id: "other-world" },
      },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_checkpoint" });
    expect(await store.getSession(SESSION_ID)).toEqual(originalSession);
    expect(await store.listMessages(SESSION_ID)).toEqual(before.messages);
    expect(await store.getWorld("shared-world")).toEqual(before.world);
    expect(await store.getWorld("other-world")).toBeNull();
  });

  it.each(["included", "omitted", "modified"])(
    "allows owner session synchronization with %s world content without rewriting the catalog",
    async (world) => {
      const before = await checkpoint();
      const upsertWorld = vi.fn();
      const withTransaction = store.withTransaction.bind(store);
      vi.spyOn(store, "withTransaction").mockImplementation((fn) =>
        withTransaction((tx) =>
          fn(
            new Proxy(tx, {
              get(target, key, receiver) {
                if (key === "upsertWorld") {
                  return (...args: Parameters<DataStore["upsertWorld"]>) => {
                    upsertWorld(...args);
                    return target.upsertWorld(...args);
                  };
                }
                return Reflect.get(target, key, receiver);
              },
            }),
          ),
        ),
      );
      const response = await request("browser-checkpoint", {
        checkpoint: {
          ...before,
          messages: [],
          world:
            world === "omitted"
              ? null
              : {
                  ...before.world!,
                  ...(world === "modified"
                    ? { description: "Unapproved global change" }
                    : {}),
                },
        },
      });
      expect(response.status).toBe(200);
      expect(upsertWorld).not.toHaveBeenCalled();
      expect(await store.listMessages(SESSION_ID)).toEqual([]);
      expect(await store.getWorld("shared-world")).toEqual(before.world);
    },
  );

  it.each(["self", "operator"])(
    "preserves authorized world imports for %s",
    async (access) => {
      if (access === "self") {
        vi.stubEnv("NODE_ENV", "development");
        vi.stubEnv("DEPLOYMENT_TIER", "self");
      }
      const before = await checkpoint();
      const response = await request(
        "browser-checkpoint",
        {
          checkpoint: {
            ...before,
            world: { ...before.world!, description: "Authorized change" },
          },
        },
        access === "operator" ? "operator-token" : "owner-a",
      );
      expect(response.status).toBe(200);
      expect((await store.getWorld("shared-world"))?.description).toBe(
        "Authorized change",
      );
    },
  );
});
