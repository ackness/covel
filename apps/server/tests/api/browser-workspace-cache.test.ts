import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createPluginRegistry } from "@covel/plugin-loader";
import { exportSessionCheckpoint } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import {
  createBrowserWorkspaceCache,
  createBrowserWorkspaceRoutes,
} from "../../src/routes/api/browser-workspace.js";
import { registerSessionDeleteRoute } from "../../src/routes/api/session/delete-route.js";
import type { SessionRouteEnv } from "../../src/routes/api/session/route-env.js";
import { hashSessionOwnerToken } from "../../src/routes/api/session/session-guard.js";

const OWNER = "synthetic-browser-owner";
const NOW = "2026-09-06T00:00:00.000Z";

async function setup() {
  const store = createMemoryStore();
  const cache = createBrowserWorkspaceCache();
  const sessionLock = createInProcessSessionLock();
  const pluginRegistry = createPluginRegistry();
  const routes = createBrowserWorkspaceRoutes(cache);
  const sessionRoutes = new Hono<SessionRouteEnv>();
  registerSessionDeleteRoute(sessionRoutes);
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("storeBackend", "memory");
    c.set("sessionLock", sessionLock);
    c.set("pluginRegistry", pluginRegistry);
    c.set("clearBrowserWorkspace", cache.clearSession);
    await next();
  });
  app.route("/api/sessions", routes);
  app.route("/api/sessions", sessionRoutes);
  await store.upsertWorld({
    id: "world",
    name: "World",
    description: "",
    createdAt: NOW,
  });

  function request(
    id: string,
    suffix: string,
    method: string,
    body?: unknown,
    owner = OWNER,
  ) {
    return app.request(`/api/sessions/${id}${suffix}`, {
      method,
      headers: { "content-type": "application/json", "x-session-token": owner },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function seed(
    id: string,
    incarnation = `${id}-original`,
    owner = OWNER,
  ) {
    await store.createSession({
      id,
      worldId: "world",
      status: "active",
      phase: "playing",
      completedPlayerTurns: 0,
      setupRuntimes: {},
      seats: [
        { id: "main", controller: "human", role: "player", characters: "auto" },
      ],
      activePlugins: [],
      locale: "zh-CN",
      metadata: {
        sessionIncarnationNonce: incarnation,
        ownerTokenHash: hashSessionOwnerToken(owner),
      },
      createdAt: NOW,
      updatedAt: NOW,
    });
  }

  async function initialize(id: string, owner = OWNER) {
    const checkpoint = await exportSessionCheckpoint(store, id, {
      revision: 1,
      actionId: "bootstrap",
    });
    expect(
      (await request(id, "/browser-checkpoint", "PUT", { checkpoint }, owner))
        .status,
    ).toBe(200);
    await store.addMessage({
      id: `${id}-message`,
      sessionId: id,
      role: "user",
      content: "Synthetic private message",
      createdAt: NOW,
    });
    const committed = await request(
      id,
      "/browser-commit",
      "POST",
      { actionId: "turn-1", baseRevision: 1 },
      owner,
    );
    expect(committed.status).toBe(200);
    return committed.json();
  }

  return { store, cache, request, seed, initialize };
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("DEPLOYMENT_TIER", "self");
  vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("browser workspace cache lifecycle", () => {
  it("releases deleted session heads and full commits while preserving other sessions' retries", async () => {
    const { store, cache, request, seed, initialize } = await setup();
    await seed("deleted");
    await seed("active");
    await initialize("deleted");
    const activeCommit = await initialize("active");
    expect(
      cache.get("deleted", "incarnation:deleted-original")?.commits.size,
    ).toBe(1);

    expect((await request("deleted", "", "DELETE")).status).toBe(200);

    expect(await store.getSession("deleted")).toBeNull();
    expect(
      cache.get("deleted", "incarnation:deleted-original"),
    ).toBeUndefined();
    const retry = await request("active", "/browser-commit", "POST", {
      actionId: "turn-1",
      baseRevision: 1,
    });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(activeCommit);
  });

  it("does not retain a deleted incarnation's revision or replay data when the id is recreated", async () => {
    const { cache, request, seed, initialize } = await setup();
    await seed("reused");
    await initialize("reused");
    expect((await request("reused", "", "DELETE")).status).toBe(200);
    expect(cache.get("reused", "incarnation:reused-original")).toBeUndefined();

    const nextOwner = "synthetic-new-owner";
    await seed("reused", "replacement", nextOwner);
    const staleRetry = await request(
      "reused",
      "/browser-commit",
      "POST",
      { actionId: "turn-1", baseRevision: 1 },
      nextOwner,
    );
    expect(staleRetry.status).toBe(409);
    expect(await staleRetry.json()).toMatchObject({
      code: "browser_checkpoint_required",
    });
    const next = await initialize("reused", nextOwner);
    expect(next).toMatchObject({
      revision: 2,
      checkpoint: { messages: [{ id: "reused-message" }] },
    });
    expect(cache.get("reused", "incarnation:replacement")?.commits.size).toBe(
      1,
    );
  });

  it("releases the cache when storage deleted the session before reporting a cleanup error", async () => {
    const { store, cache, request, seed, initialize } = await setup();
    await seed("deleted");
    await initialize("deleted");
    const deleteSession = store.deleteSession.bind(store);
    vi.spyOn(store, "deleteSession").mockImplementationOnce(async (id) => {
      await deleteSession(id);
      throw new Error("Synthetic cleanup failure after deletion");
    });

    expect((await request("deleted", "", "DELETE")).status).toBe(200);
    expect(
      cache.get("deleted", "incarnation:deleted-original"),
    ).toBeUndefined();
  });

  it("keeps the current owner's replay cache when another owner cannot delete the session", async () => {
    const { cache, request, seed, initialize } = await setup();
    await seed("active");
    const committed = await initialize("active");

    expect(
      (await request("active", "", "DELETE", undefined, "wrong-owner")).status,
    ).toBe(401);
    expect(
      cache.get("active", "incarnation:active-original")?.commits.size,
    ).toBe(1);
    const retry = await request("active", "/browser-commit", "POST", {
      actionId: "turn-1",
      baseRevision: 1,
    });
    expect(await retry.json()).toEqual(committed);
  });

  it("keeps replay state after a failed deletion and releases it when DELETE is retried", async () => {
    const { store, cache, request, seed, initialize } = await setup();
    await seed("retry");
    await initialize("retry");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(store, "deleteSession").mockRejectedValueOnce(
      new Error("Synthetic deletion failure"),
    );

    expect((await request("retry", "", "DELETE")).status).toBe(500);
    expect(await store.getSession("retry")).not.toBeNull();
    expect(cache.get("retry", "incarnation:retry-original")?.commits.size).toBe(
      1,
    );

    expect((await request("retry", "", "DELETE")).status).toBe(200);
    expect(await store.getSession("retry")).toBeNull();
    expect(cache.get("retry", "incarnation:retry-original")).toBeUndefined();
  });

  it("evicts browser workspace heads by TTL and LRU capacity", async () => {
    let clock = 1_000;
    const cache = createBrowserWorkspaceCache(() => clock);
    const makeHead = (id: string) => ({
      incarnation: `inc:${id}`,
      revision: 1,
      actionId: "init",
      checkpoint: {} as Parameters<typeof cache.set>[1]["checkpoint"],
      commits: new Map(),
    });

    cache.set("ttl-session", makeHead("ttl-session"));
    expect(cache.get("ttl-session", "inc:ttl-session")).toBeDefined();

    // Advance past the 30 minute TTL.
    clock += 30 * 60_000 + 1;
    expect(cache.get("ttl-session", "inc:ttl-session")).toBeUndefined();

    // Fill beyond the 256-entry LRU bound and touch s-0 so s-1 becomes LRU.
    for (let i = 0; i < 256; i++) {
      cache.set(`s-${i}`, makeHead(`s-${i}`));
    }
    expect(cache.get("s-0", "inc:s-0")).toBeDefined();
    cache.set("s-overflow", makeHead("s-overflow"));
    expect(cache.get("s-1", "inc:s-1")).toBeUndefined();
    expect(cache.get("s-0", "inc:s-0")).toBeDefined();
    expect(cache.get("s-overflow", "inc:s-overflow")).toBeDefined();
  });

  it("invokes clearPluginEntrySession when deleting a session", async () => {
    const store = createMemoryStore();
    const sessionLock = createInProcessSessionLock();
    const pluginRegistry = createPluginRegistry();
    const clearPluginEntrySession = vi.fn();
    const sessionRoutes = new Hono<SessionRouteEnv>();
    registerSessionDeleteRoute(sessionRoutes);
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("store", store);
      c.set("storeBackend", "memory");
      c.set("sessionLock", sessionLock);
      c.set("pluginRegistry", pluginRegistry);
      c.set("clearPluginEntrySession", clearPluginEntrySession);
      await next();
    });
    app.route("/api/sessions", sessionRoutes);
    await store.upsertWorld({
      id: "world",
      name: "World",
      description: "",
      createdAt: NOW,
    });
    await store.createSession({
      id: "clean-me",
      worldId: "world",
      status: "active",
      phase: "playing",
      completedPlayerTurns: 0,
      setupRuntimes: {},
      seats: [
        { id: "main", controller: "human", role: "player", characters: "auto" },
      ],
      activePlugins: [],
      locale: "zh-CN",
      metadata: {
        sessionIncarnationNonce: "inc",
        ownerTokenHash: hashSessionOwnerToken(OWNER),
      },
      createdAt: NOW,
      updatedAt: NOW,
    });

    const res = await app.request("/api/sessions/clean-me", {
      method: "DELETE",
      headers: { "x-session-token": OWNER },
    });
    expect(res.status).toBe(200);
    expect(clearPluginEntrySession).toHaveBeenCalledWith("clean-me");
  });
});
