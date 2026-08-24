/**
 * SessionStart / SessionEnd hook wiring tests.
 *
 * Verifies the session-lifecycle hooks fire from the session routes:
 * - SessionStart on POST /api/sessions (after create + plugin activation)
 * - SessionEnd on PATCH status→ended and on DELETE
 */

import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { createStateManager } from "@covel/state";
import { createPluginRegistry } from "@covel/plugin-loader";
import { createRpcApprovalGate } from "@covel/approval";
import { createMemoryMediaStore, createMemoryStore } from "@covel/store";
import { createHookPipeline } from "@covel/runtime";
import { sessionRoutes } from "../../src/routes/api/session.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { backgroundRuntimeLockId } from "../../src/routes/api/plugin-rpc/runtime-turn.js";

const TEST_APPROVAL_SCOPE = "session-lifecycle-test-scope";

function build() {
  const store = createMemoryStore();
  const hookPipeline = createHookPipeline();
  const sessionLock = createInProcessSessionLock();
  const pluginRegistry = createPluginRegistry();
  const rpcApprovalGate = createRpcApprovalGate();
  const mediaStore = createMemoryMediaStore();
  const clearSessionToolOverrides = vi.fn();
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("stateManager", createStateManager(store));
    c.set("pluginRegistry", pluginRegistry);
    c.set("rpcApprovalGate", rpcApprovalGate);
    c.set("mediaStore", mediaStore);
    c.set("clearSessionToolOverrides", clearSessionToolOverrides);
    c.set("hookPipeline", hookPipeline);
    c.set("sessionLock", sessionLock);
    await next();
  });
  app.route("/api/sessions", sessionRoutes);
  return {
    app,
    hookPipeline,
    sessionLock,
    store,
    pluginRegistry,
    rpcApprovalGate,
    mediaStore,
    clearSessionToolOverrides,
  };
}

async function createSession(app: Hono): Promise<string> {
  const res = await app.request("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ worldId: "cloudmere", locale: "en-US" }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { id: string };
  return body.id;
}

function registerCommunityPlugin(
  pluginRegistry: ReturnType<typeof createPluginRegistry>,
): void {
  pluginRegistry.register({
    id: "community-plugin",
    summary: {
      id: "community-plugin",
      name: "Community Plugin",
      description: "test",
      pluginType: "plugin",
      runtimeCount: 1,
    },
    manifest: {
      manifest: {
        name: "community-plugin/runtime",
        pluginId: "community-plugin",
        description: "test",
        runtimeType: "function",
        stage: "narrative",
      },
      promptTemplate: "",
      rawFrontmatter: {},
    },
    loadedRuntimes: new Map(),
    status: "registered",
  });
}

function grantSessionApproval(
  gate: ReturnType<typeof createRpcApprovalGate>,
  sessionId: string,
): void {
  const grant = gate.evaluate({
    sessionId,
    sessionScope: TEST_APPROVAL_SCOPE,
    pluginId: "community-plugin",
    action: "write",
    payload: {},
    trustLevel: "community",
  });
  if (grant.status !== "pending") throw new Error("expected approval");
  gate.decide(
    {
      approvalId: grant.approvalId,
      decision: "allow",
      scope: "session",
      decidedAt: new Date().toISOString(),
    },
    TEST_APPROVAL_SCOPE,
  );
}

describe("Session lifecycle hooks", () => {
  it("fires SessionStart on session creation with sessionId + worldId", async () => {
    const { app, hookPipeline } = build();
    const handler = vi.fn().mockResolvedValue({ action: "continue" });
    hookPipeline.register({
      id: "test:SessionStart:0",
      event: "SessionStart",
      handler,
    });

    const id = await createSession(app);

    expect(handler).toHaveBeenCalledTimes(1);
    const [, payload] = handler.mock.calls[0];
    expect(payload).toMatchObject({ sessionId: id, worldId: "cloudmere" });
  });

  it("lets SessionStart call the same session API without deadlocking", async () => {
    const { app, hookPipeline, store } = build();
    hookPipeline.register({
      id: "test:SessionStart:http-reentry",
      event: "SessionStart",
      handler: async (_context, payload) => {
        const lifecycleResponse = await app.request(
          `/api/sessions/${payload.sessionId}`,
          { method: "DELETE" },
        );
        expect(lifecycleResponse.status).toBe(409);
        expect(
          (await lifecycleResponse.json()) as { code?: string },
        ).toMatchObject({ code: "session_lifecycle_busy" });
        const response = await app.request(
          `/api/sessions/${payload.sessionId}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              runtimeModelOverrides: { narrator: "hook-slot" },
            }),
          },
        );
        expect(response.status).toBe(200);
        return { action: "continue" };
      },
    });

    const creation = createSession(app);
    const id = await Promise.race([
      creation,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("SessionStart re-entry timed out")),
          500,
        ),
      ),
    ]);
    expect((await store.getSession(id))?.runtimeModelOverrides).toEqual({
      narrator: "hook-slot",
    });
  });

  it("still returns the one-time owner token when lifecycle marker cleanup fails", async () => {
    const { app, store } = build();
    const originalUpdate = store.updateSession.bind(store);
    vi.spyOn(store, "updateSession").mockImplementation(async (id, patch) => {
      if (
        patch.metadata &&
        Object.hasOwn(patch.metadata, "sessionLifecyclePending") &&
        patch.metadata.sessionLifecyclePending === undefined
      ) {
        throw new Error("cleanup connection reset");
      }
      return originalUpdate(id, patch);
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    let response!: Response;
    try {
      response = await app.request("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "owner-token-survives-cleanup" }),
      });
    } finally {
      warning.mockRestore();
    }
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      id: string;
      ownerToken?: string;
      metadata?: Record<string, unknown>;
    };
    expect(body.ownerToken).toEqual(expect.any(String));
    expect(body.metadata).not.toHaveProperty("sessionLifecyclePending");
    expect(await store.getSession(body.id)).not.toBeNull();
  });

  it("returns the owner token and skips SessionStart when lease refresh fails", async () => {
    const { app, hookPipeline, store } = build();
    const startHandler = vi.fn().mockResolvedValue({ action: "continue" });
    hookPipeline.register({
      id: "test:SessionStart:lease-refresh-failure",
      event: "SessionStart",
      handler: startHandler,
    });
    vi.spyOn(store, "updateSession").mockImplementationOnce(async () => {
      throw new Error("lease refresh connection reset");
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    let response!: Response;
    try {
      response = await app.request("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "owner-token-survives-refresh" }),
      });
    } finally {
      warning.mockRestore();
    }
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      id: string;
      ownerToken?: string;
    };
    expect(body.ownerToken).toEqual(expect.any(String));
    expect(startHandler).not.toHaveBeenCalled();
    expect(
      (await store.getSession(body.id))?.metadata?.sessionLifecyclePending,
    ).toBeUndefined();
  });

  it("rejects delete while SessionStart is in progress and succeeds on retry", async () => {
    const { app, hookPipeline, store } = build();
    const id = "create-delete-linearized";
    let releaseHook!: () => void;
    let markHookStarted!: () => void;
    const hookStarted = new Promise<void>((resolve) => {
      markHookStarted = resolve;
    });
    const hookGate = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });
    hookPipeline.register({
      id: "test:SessionStart:block-create",
      event: "SessionStart",
      handler: async () => {
        markHookStarted();
        await hookGate;
        return { action: "continue" };
      },
    });

    const creating = app.request("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    await hookStarted;
    expect(await store.getSession(id)).not.toBeNull();

    const overlappingDelete = await app.request(`/api/sessions/${id}`, {
      method: "DELETE",
    });
    expect(overlappingDelete.status).toBe(409);
    expect((await overlappingDelete.json()) as { code?: string }).toMatchObject(
      { code: "session_lifecycle_busy" },
    );

    releaseHook();
    expect((await creating).status).toBe(200);
    expect(
      (await app.request(`/api/sessions/${id}`, { method: "DELETE" })).status,
    ).toBe(200);
    expect(await store.getSession(id)).toBeNull();
  });

  it("fires SessionEnd on transition to ended (and not twice)", async () => {
    const { app, hookPipeline } = build();
    const handler = vi.fn().mockResolvedValue({ action: "continue" });
    hookPipeline.register({
      id: "test:SessionEnd:0",
      event: "SessionEnd",
      handler,
    });

    const id = await createSession(app);

    const patch = async (status: string) =>
      app.request(`/api/sessions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });

    // Pause first — no SessionEnd.
    await patch("paused");
    expect(handler).not.toHaveBeenCalled();

    // Transition to ended — one SessionEnd.
    await patch("ended");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][1]).toMatchObject({
      sessionId: id,
      reason: "ended",
    });

    // Re-patching an already-ended session does not fire again.
    await patch("ended");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("rejects a status transition re-entered from SessionEnd without deadlocking", async () => {
    const { app, hookPipeline, store } = build();
    hookPipeline.register({
      id: "test:SessionEnd:http-reentry",
      event: "SessionEnd",
      handler: async (_context, payload) => {
        const response = await app.request(
          `/api/sessions/${payload.sessionId}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ status: "active" }),
          },
        );
        expect(response.status).toBe(409);
        expect((await response.json()) as { code?: string }).toMatchObject({
          code: "session_lifecycle_busy",
        });
        return { action: "continue" };
      },
    });
    const id = await createSession(app);

    const ending = app.request(`/api/sessions/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "ended" }),
    });
    const response = await Promise.race([
      ending,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("SessionEnd re-entry timed out")),
          500,
        ),
      ),
    ]);
    expect(response.status).toBe(200);
    expect((await store.getSession(id))?.status).toBe("ended");
  });

  it("fires SessionEnd with reason 'deleted' on DELETE", async () => {
    const { app, hookPipeline } = build();
    const handler = vi.fn().mockResolvedValue({ action: "continue" });
    hookPipeline.register({
      id: "test:SessionEnd:del",
      event: "SessionEnd",
      handler,
    });

    const id = await createSession(app);
    await app.request(`/api/sessions/${id}`, { method: "DELETE" });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][1]).toMatchObject({
      sessionId: id,
      reason: "deleted",
    });
  });

  it("purges process-local activations, approvals, and tool overrides after DELETE", async () => {
    const { app, pluginRegistry, rpcApprovalGate, clearSessionToolOverrides } =
      build();
    registerCommunityPlugin(pluginRegistry);
    const id = await createSession(app);
    pluginRegistry.activate("community-plugin", id);
    grantSessionApproval(rpcApprovalGate, id);
    const pending = rpcApprovalGate.evaluate({
      sessionId: id,
      sessionScope: TEST_APPROVAL_SCOPE,
      pluginId: "community-plugin",
      action: "delete",
      payload: {},
      trustLevel: "community",
    });
    expect(pending.status).toBe("pending");

    expect(
      (await app.request(`/api/sessions/${id}`, { method: "DELETE" })).status,
    ).toBe(200);

    expect(pluginRegistry.getActiveRuntimes(id)).toEqual([]);
    expect(
      rpcApprovalGate.hasGrant(
        id,
        "community-plugin",
        "write",
        TEST_APPROVAL_SCOPE,
      ),
    ).toBe(false);
    expect(rpcApprovalGate.listPending(id, TEST_APPROVAL_SCOPE)).toEqual([]);
    expect(clearSessionToolOverrides).toHaveBeenCalledWith(id);
  });

  it("keeps process-local state when the database delete fails", async () => {
    const {
      app,
      store,
      pluginRegistry,
      rpcApprovalGate,
      clearSessionToolOverrides,
    } = build();
    registerCommunityPlugin(pluginRegistry);
    const id = await createSession(app);
    pluginRegistry.activate("community-plugin", id);
    grantSessionApproval(rpcApprovalGate, id);
    vi.spyOn(store, "deleteSession").mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      expect(
        (await app.request(`/api/sessions/${id}`, { method: "DELETE" })).status,
      ).toBe(500);
    } finally {
      errorLog.mockRestore();
    }

    expect(pluginRegistry.getActiveRuntimes(id)).toHaveLength(1);
    expect(
      rpcApprovalGate.hasGrant(
        id,
        "community-plugin",
        "write",
        TEST_APPROVAL_SCOPE,
      ),
    ).toBe(true);
    expect(clearSessionToolOverrides).not.toHaveBeenCalled();
    expect((await store.getSession(id))?.status).toBe("paused");
    expect(
      (await store.getSession(id))?.metadata?.deletionPendingNonce,
    ).toEqual(expect.any(String));
    const reopen = await app.request(`/api/sessions/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "active" }),
    });
    expect(reopen.status).toBe(409);
    expect(
      (await app.request(`/api/sessions/${id}`, { method: "DELETE" })).status,
    ).toBe(200);
    expect(await store.getSession(id)).toBeNull();
  });

  it("makes a drain-lock failure immediately retryable without firing SessionEnd twice", async () => {
    const { app, hookPipeline, sessionLock, store } = build();
    const endHandler = vi.fn().mockResolvedValue({ action: "continue" });
    hookPipeline.register({
      id: "test:SessionEnd:drain-retry",
      event: "SessionEnd",
      handler: endHandler,
    });
    const id = await createSession(app);
    vi.spyOn(sessionLock, "withLocks").mockRejectedValueOnce(
      new Error("advisory lock unavailable"),
    );
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      expect(
        (await app.request(`/api/sessions/${id}`, { method: "DELETE" })).status,
      ).toBe(500);
    } finally {
      errorLog.mockRestore();
    }
    expect((await store.getSession(id))?.status).toBe("paused");
    expect((await store.getSession(id))?.metadata?.deletionRetryNonce).toEqual(
      (await store.getSession(id))?.metadata?.deletionPendingNonce,
    );

    expect(
      (await app.request(`/api/sessions/${id}`, { method: "DELETE" })).status,
    ).toBe(200);
    expect(endHandler).toHaveBeenCalledTimes(1);
    expect(await store.getSession(id)).toBeNull();
  });

  it("treats a post-COMMIT delete error as success and clears local state", async () => {
    const {
      app,
      store,
      pluginRegistry,
      rpcApprovalGate,
      clearSessionToolOverrides,
    } = build();
    registerCommunityPlugin(pluginRegistry);
    const id = await createSession(app);
    pluginRegistry.activate("community-plugin", id);
    grantSessionApproval(rpcApprovalGate, id);
    const originalDelete = store.deleteSession.bind(store);
    vi.spyOn(store, "deleteSession").mockImplementationOnce(
      async (sessionId) => {
        await originalDelete(sessionId);
        throw new Error("connection reset after commit");
      },
    );

    const response = await app.request(`/api/sessions/${id}`, {
      method: "DELETE",
    });
    expect(response.status).toBe(200);
    expect(await store.getSession(id)).toBeNull();
    expect(pluginRegistry.getActiveRuntimes(id)).toEqual([]);
    expect(
      rpcApprovalGate.hasGrant(
        id,
        "community-plugin",
        "write",
        TEST_APPROVAL_SCOPE,
      ),
    ).toBe(false);
    expect(clearSessionToolOverrides).toHaveBeenCalledWith(id);
  });

  it("waits for an active session writer before cascading delete", async () => {
    const { app, sessionLock, store } = build();
    const id = await createSession(app);
    let releaseWriter!: () => void;
    let markWriterStarted!: () => void;
    const writerStarted = new Promise<void>((resolve) => {
      markWriterStarted = resolve;
    });
    const writerGate = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    const writer = sessionLock.withLock(id, async () => {
      markWriterStarted();
      await writerGate;
      await store.addMessage({
        id: "late-message",
        sessionId: id,
        role: "assistant",
        content: "completed before delete",
        createdAt: new Date().toISOString(),
      });
    });
    await writerStarted;

    const deleting = app.request(`/api/sessions/${id}`, { method: "DELETE" });
    await Promise.resolve();
    expect(await store.getSession(id)).not.toBeNull();

    releaseWriter();
    await writer;
    expect((await deleting).status).toBe(200);
    expect(await store.getSession(id)).toBeNull();
    expect(await store.listMessages(id)).toEqual([]);
  });

  it("drains detached runtime work before deleting execution artifacts", async () => {
    const { app, sessionLock, store, mediaStore } = build();
    const id = await createSession(app);
    let releaseRuntime!: () => void;
    let markRuntimeStarted!: () => void;
    const runtimeStarted = new Promise<void>((resolve) => {
      markRuntimeStarted = resolve;
    });
    const runtimeGate = new Promise<void>((resolve) => {
      releaseRuntime = resolve;
    });
    await store.setPluginData({
      id: "pending-late-job",
      sessionId: id,
      pluginId: "community-plugin",
      namespace: "_jobs",
      key: "late-job",
      value: {
        status: "pending",
        runtimeId: "community-plugin/runtime",
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const media = await mediaStore.put(
      new Uint8Array([1, 2, 3, 4]),
      "application/octet-stream",
    );
    const detached = sessionLock.withLock(
      backgroundRuntimeLockId(id, "community-plugin/runtime"),
      async () => {
        markRuntimeStarted();
        await runtimeGate;
        await mediaStore.recordOwnership(media.id, id, "community-plugin");
        await mediaStore.addRef(media.id, id, "community-plugin");
        await store.saveTurnResult({
          id: "late-result",
          sessionId: id,
          turnId: "late-turn",
          runtimeResults: [],
          commitStatus: "pending",
          durationMs: 1,
          createdAt: new Date().toISOString(),
        });
      },
    );
    await runtimeStarted;

    const deleting = app.request(`/api/sessions/${id}`, { method: "DELETE" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(await store.getSession(id)).not.toBeNull();

    releaseRuntime();
    await detached;
    expect((await deleting).status).toBe(200);
    expect(await store.getSession(id)).toBeNull();
    expect(await store.listTurnResults(id)).toEqual([]);
    expect(await mediaStore.isReferencedBy(media.id, id)).toBe(false);

    expect(
      (
        await app.request("/api/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id }),
        })
      ).status,
    ).toBe(200);
    expect(await mediaStore.isReferencedBy(media.id, id)).toBe(false);
  });

  it("does not recreate an id until delete cleanup releases the session lock", async () => {
    const { app, hookPipeline, store } = build();
    const id = await createSession(app);
    let releaseHook!: () => void;
    let markHookStarted!: () => void;
    const hookStarted = new Promise<void>((resolve) => {
      markHookStarted = resolve;
    });
    const hookGate = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });
    hookPipeline.register({
      id: "test:SessionEnd:block-delete-cleanup",
      event: "SessionEnd",
      handler: async () => {
        markHookStarted();
        await hookGate;
        return { action: "continue" };
      },
    });

    const deleting = app.request(`/api/sessions/${id}`, { method: "DELETE" });
    await hookStarted;
    expect((await store.getSession(id))?.status).toBe("paused");

    const overlappingCreate = await app.request("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    expect(overlappingCreate.status).toBe(409);

    releaseHook();
    expect((await deleting).status).toBe(200);
    expect(
      (
        await app.request("/api/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id }),
        })
      ).status,
    ).toBe(200);
    expect(await store.getSession(id)).not.toBeNull();
  });

  it("does not fire SessionEnd again when DELETE-ing an already-ended session", async () => {
    const { app, hookPipeline } = build();
    const handler = vi.fn().mockResolvedValue({ action: "continue" });
    hookPipeline.register({
      id: "test:SessionEnd:ended-then-deleted",
      event: "SessionEnd",
      handler,
    });

    const id = await createSession(app);

    // End the session — fires SessionEnd once (reason: ended).
    await app.request(`/api/sessions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "ended" }),
    });
    expect(handler).toHaveBeenCalledTimes(1);

    // DELETE the already-ended session — the `status !== "ended"` guard means
    // no second SessionEnd, so a single session never emits two end signals.
    await app.request(`/api/sessions/${id}`, { method: "DELETE" });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][1]).toMatchObject({
      sessionId: id,
      reason: "ended",
    });
  });
});
