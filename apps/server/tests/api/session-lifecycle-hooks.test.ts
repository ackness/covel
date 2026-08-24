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
import { createMemoryStore } from "@covel/store";
import { createHookPipeline } from "@covel/runtime";
import { sessionRoutes } from "../../src/routes/api/session.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";

function build() {
  const store = createMemoryStore();
  const hookPipeline = createHookPipeline();
  const sessionLock = createInProcessSessionLock();
  const pluginRegistry = createPluginRegistry();
  const rpcApprovalGate = createRpcApprovalGate();
  const clearSessionToolOverrides = vi.fn();
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("stateManager", createStateManager(store));
    c.set("pluginRegistry", pluginRegistry);
    c.set("rpcApprovalGate", rpcApprovalGate);
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
    pluginId: "community-plugin",
    action: "write",
    payload: {},
    trustLevel: "community",
  });
  if (grant.status !== "pending") throw new Error("expected approval");
  gate.decide({
    approvalId: grant.approvalId,
    decision: "allow",
    scope: "session",
    decidedAt: new Date().toISOString(),
  });
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
    expect(rpcApprovalGate.hasGrant(id, "community-plugin", "write")).toBe(
      false,
    );
    expect(rpcApprovalGate.listPending(id)).toEqual([]);
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
    expect(rpcApprovalGate.hasGrant(id, "community-plugin", "write")).toBe(
      true,
    );
    expect(clearSessionToolOverrides).not.toHaveBeenCalled();
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
