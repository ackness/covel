/**
 * Tests for session turn-tree branch routes and `submit_actions.payload.branchFromNodeId`.
 *
 * GET    /api/sessions/:id/branches
 * POST   /api/sessions/:id/branches/switch
 * PATCH  /api/sessions/:id/branches/nodes/:nodeId
 * DELETE /api/sessions/:id/branches/nodes/:nodeId
 * POST   /api/actions (submit_actions.payload.branchFromNodeId)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createEventBus } from "@covel/events";
import { createHookPipeline } from "@covel/runtime";
import { createPluginRegistry } from "@covel/plugin-loader";
import type { DataStore, TurnNodeRecord } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import { makeTurnNode } from "@covel/store/testing";
import { makeErrorHandler } from "../../src/api-error.js";
import {
  createInProcessSessionLock,
  type SessionLock,
} from "../../src/lib/session-lock.js";
import { actionRoutes } from "../../src/routes/api/actions.js";
import { branchRoutes } from "../../src/routes/api/branches.js";
import { SESSION_DELETION_PENDING_KEY } from "../../src/routes/api/session/session-guard.js";
import { makeFakeLLM, makeFakeLoadedRuntime } from "./__helpers/fake-llm.js";

const client = vi.hoisted(() => ({ address: "" }));
vi.mock("@hono/node-server/conninfo", () => ({
  getConnInfo: () => ({ remote: { address: client.address } }),
}));

function makeNode(
  overrides: Partial<TurnNodeRecord> & { id: string; sessionId: string },
): TurnNodeRecord {
  return makeTurnNode({
    parentNodeId: null,
    activeChildId: null,
    turnId: `turn-${overrides.id}`,
    turnIds: [`turn-${overrides.id}`],
    logicalTurn: 0,
    seq: 0,
    checkpointKind: "delta",
    baseNodeId: "root",
    depthFromBase: 1,
    statePayload: {},
    ...overrides,
  });
}

async function seedSession(
  store: DataStore,
  id: string,
  overrides: {
    activeNodeId?: string | null;
    branchEpoch?: number;
    metadata?: Record<string, unknown>;
  } = {},
) {
  const now = new Date().toISOString();
  await store.createSession({
    id,
    status: "active",
    phase: "playing",
    locale: "en",
    activePlugins: ["fake-narrator"],
    completedPlayerTurns: 1,
    setupRuntimes: {},
    seats: [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
    activeNodeId: overrides.activeNodeId ?? null,
    branchEpoch: overrides.branchEpoch ?? 0,
    branchWriteWatermark: 0,
    metadata: {
      approvalScopeNonce: crypto.randomUUID(),
      sessionIncarnationNonce: crypto.randomUUID(),
      ...overrides.metadata,
    },
    createdAt: now,
    updatedAt: now,
  });
}

function createApp(
  store: DataStore,
  options: {
    sessionLock?: SessionLock;
    ensureEmbeddingLock?: (sessionId: string) => Promise<void>;
  } = {},
) {
  const registry = createPluginRegistry();
  const narrator = makeFakeLoadedRuntime({
    name: "fake-narrator",
    pluginId: "fake-narrator",
    outputKind: "story",
  });
  registry.register({
    id: "fake-narrator",
    source: "builtin",
    summary: {
      id: "fake-narrator",
      name: "fake-narrator",
      description: "",
      kind: "plugin",
      runtimeCount: 1,
    },
    manifests: [
      {
        runtime: {},
        manifest: narrator.manifest,
        promptTemplate: narrator.promptTemplate,
        rawFrontmatter: {},
      },
    ],
    status: "registered",
  });

  const { llm } = makeFakeLLM("ok");
  const eventBus = createEventBus(store);
  const hookPipeline = createHookPipeline();
  const sessionLock = options.sessionLock ?? createInProcessSessionLock();

  const app = new Hono();
  app.onError(makeErrorHandler("[branches test]", false));
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("sessionLock", sessionLock);
    c.set("pluginRegistry", registry);
    c.set("llmAdapter", llm);
    c.set("loadRuntimeFn", async () => narrator);
    c.set("resolveModel", () => undefined);
    c.set("eventBus", eventBus);
    c.set("hookPipeline", hookPipeline);
    if (options.ensureEmbeddingLock) {
      c.set("ensureEmbeddingLock", options.ensureEmbeddingLock);
    }
    await next();
  });
  app.route("/api/sessions", branchRoutes);
  app.route("/api/actions", actionRoutes);
  return app;
}

function parseSseEvents(text: string): Array<{ event: string; data: unknown }> {
  return text
    .trim()
    .split(/\n\n+/)
    .filter(Boolean)
    .map((block) => {
      let event = "";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      return { event, data: data ? JSON.parse(data) : null };
    });
}

describe("session branch routes", () => {
  let store: DataStore;
  let app: Hono;
  const sessionId = "sess-branches";
  const otherSessionId = "sess-other";

  beforeEach(async () => {
    client.address = crypto.randomUUID();
    store = createMemoryStore();
    await seedSession(store, sessionId, {
      activeNodeId: "leaf-a",
      branchEpoch: 1,
    });
    await seedSession(store, otherSessionId, {
      activeNodeId: "other-root",
      branchEpoch: 0,
    });
    await store.saveTurnNode(
      makeNode({
        id: "root",
        sessionId,
        parentNodeId: null,
        activeChildId: "branch-a",
        checkpointKind: "base",
        depthFromBase: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await store.saveTurnNode(
      makeNode({
        id: "branch-a",
        sessionId,
        parentNodeId: "root",
        activeChildId: "leaf-a",
        seq: 0,
        label: "Main line",
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await store.saveTurnNode(
      makeNode({
        id: "leaf-a",
        sessionId,
        parentNodeId: "branch-a",
        seq: 0,
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await store.saveTurnNode(
      makeNode({
        id: "branch-b",
        sessionId,
        parentNodeId: "root",
        activeChildId: "leaf-b",
        seq: 1,
        label: "Side line",
        createdAt: "2026-01-01T00:00:03.000Z",
      }),
    );
    await store.saveTurnNode(
      makeNode({
        id: "leaf-b",
        sessionId,
        parentNodeId: "branch-b",
        seq: 0,
        createdAt: "2026-01-01T00:00:04.000Z",
      }),
    );
    await store.saveTurnNode(
      makeNode({
        id: "other-root",
        sessionId: otherSessionId,
        parentNodeId: null,
        checkpointKind: "base",
        baseNodeId: "other-root",
        depthFromBase: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    app = createApp(store);
  });

  it("lists branch topology with accurate child counts and returns 404 for unknown sessions", async () => {
    const res = await app.request(`/api/sessions/${sessionId}/branches`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      activeNodeId: string | null;
      branchEpoch: number;
      nodes: Array<{ id: string; childCount?: number; label?: string }>;
    };
    expect(body.activeNodeId).toBe("leaf-a");
    expect(body.branchEpoch).toBe(1);
    expect(body.nodes.map((n) => [n.id, n.childCount, n.label])).toEqual([
      ["root", 2, undefined],
      ["branch-a", 1, "Main line"],
      ["leaf-a", 0, undefined],
      ["branch-b", 1, "Side line"],
      ["leaf-b", 0, undefined],
    ]);

    const missing = await app.request("/api/sessions/does-not-exist/branches");
    expect(missing.status).toBe(404);
  });

  it("renames and clears branch node labels while guarding root nodes, cross-session nodes, and deleting sessions", async () => {
    const rename = await app.request(
      `/api/sessions/${sessionId}/branches/nodes/branch-b`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "Dark ending" }),
      },
    );
    expect(rename.status).toBe(200);
    expect(await rename.json()).toMatchObject({
      id: "branch-b",
      label: "Dark ending",
    });

    const clear = await app.request(
      `/api/sessions/${sessionId}/branches/nodes/branch-b`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: null }),
      },
    );
    expect(clear.status).toBe(200);
    const clearedBody = (await clear.json()) as Record<string, unknown>;
    expect("label" in clearedBody).toBe(false);

    const renameRoot = await app.request(
      `/api/sessions/${sessionId}/branches/nodes/root`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "Nope" }),
      },
    );
    expect(renameRoot.status).toBe(400);
    expect(await renameRoot.json()).toMatchObject({
      code: "cannot_rename_root_node",
    });

    const crossSession = await app.request(
      `/api/sessions/${sessionId}/branches/nodes/other-root`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "Cross" }),
      },
    );
    expect(crossSession.status).toBe(404);

    const invalidBody = await app.request(
      `/api/sessions/${sessionId}/branches/nodes/branch-b`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "x".repeat(257) }),
      },
    );
    expect(invalidBody.status).toBe(400);

    // A session with deletion pending must reject mutations under the lock.
    await store.updateSession(sessionId, {
      metadata: { [SESSION_DELETION_PENDING_KEY]: "deleting-nonce" },
    });
    const whileDeleting = await app.request(
      `/api/sessions/${sessionId}/branches/nodes/branch-b`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "Blocked" }),
      },
    );
    expect(whileDeleting.status).toBe(409);
    expect(await whileDeleting.json()).toMatchObject({
      code: "session_deleting",
    });
  });

  it("deletes inactive subtrees atomically, updates parent activeChildId, and rejects malformed bodies or active subtrees", async () => {
    // Malformed JSON must fail closed instead of silently deleting the branch.
    const malformed = await app.request(
      `/api/sessions/${sessionId}/branches/nodes/branch-b`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: "{not-json",
      },
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ code: "invalid_json_body" });
    expect(await store.getTurnNode("branch-b")).not.toBeNull();

    const extraField = await app.request(
      `/api/sessions/${sessionId}/branches/nodes/branch-b`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ unexpected: true }),
      },
    );
    expect(extraField.status).toBe(400);
    expect(await store.getTurnNode("branch-b")).not.toBeNull();

    // Deleting the root node or any ancestor of activeNodeId is refused.
    const deleteRoot = await app.request(
      `/api/sessions/${sessionId}/branches/nodes/root`,
      { method: "DELETE" },
    );
    expect(deleteRoot.status).toBe(400);
    expect(await deleteRoot.json()).toMatchObject({
      code: "cannot_delete_root_node",
    });

    const deleteActiveAncestor = await app.request(
      `/api/sessions/${sessionId}/branches/nodes/branch-a`,
      { method: "DELETE" },
    );
    expect(deleteActiveAncestor.status).toBe(409);
    expect(await deleteActiveAncestor.json()).toMatchObject({
      code: "branch_checkout_required",
    });
    expect(await store.getTurnNode("branch-a")).not.toBeNull();
    expect(await store.getTurnNode("leaf-a")).not.toBeNull();

    // Add a third child under root and point root.activeChildId to branch-b to test replacement.
    await store.saveTurnNode(
      makeNode({
        id: "branch-c",
        sessionId,
        parentNodeId: "root",
        seq: 2,
        createdAt: "2026-01-01T00:00:05.000Z",
      }),
    );
    const rootNode = (await store.getTurnNode("root"))!;
    await store.saveTurnNode({ ...rootNode, activeChildId: "branch-b" });

    // Empty body DELETE removes branch-b and leaf-b and repoints root.activeChildId to branch-a (lowest seq).
    const deleted = await app.request(
      `/api/sessions/${sessionId}/branches/nodes/branch-b`,
      { method: "DELETE" },
    );
    expect(deleted.status).toBe(200);
    const body = (await deleted.json()) as {
      deletedNodeIds: string[];
      activeNodeId: string | null;
      branchEpoch: number;
      switched: boolean;
    };
    expect(new Set(body.deletedNodeIds)).toEqual(
      new Set(["branch-b", "leaf-b"]),
    );
    expect(body.activeNodeId).toBe("leaf-a");
    expect(body.branchEpoch).toBe(1);
    expect(body.switched).toBe(false);
    expect(await store.getTurnNode("branch-b")).toBeNull();
    expect(await store.getTurnNode("leaf-b")).toBeNull();
    expect((await store.getTurnNode("root"))?.activeChildId).toBe("branch-a");
  });

  it("returns 501 for branch switch until checkoutTurnNode is wired, and executes it when supplied", async () => {
    const invalid = await app.request(
      `/api/sessions/${sessionId}/branches/switch`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(invalid.status).toBe(400);

    const unavailable = await app.request(
      `/api/sessions/${sessionId}/branches/switch`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nodeId: "leaf-b" }),
      },
    );
    expect(unavailable.status).toBe(501);
    expect(await unavailable.json()).toMatchObject({
      code: "branching_unavailable",
    });

    // When a checkout capability is present, missing/cross-session nodes return 404 and valid ones succeed.
    const checkoutSpy = vi.fn(async (sid: string, targetNodeId: string) => {
      await store.updateSession(sid, {
        activeNodeId: targetNodeId,
        branchEpoch: 2,
      });
    });
    const capableStore = Object.assign(Object.create(store) as DataStore, {
      checkoutTurnNode: checkoutSpy,
    });
    const capableApp = createApp(capableStore);

    const cross = await capableApp.request(
      `/api/sessions/${sessionId}/branches/switch`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nodeId: "other-root" }),
      },
    );
    expect(cross.status).toBe(404);
    expect(checkoutSpy).not.toHaveBeenCalled();

    const ok = await capableApp.request(
      `/api/sessions/${sessionId}/branches/switch`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nodeId: "leaf-b", discardUnsettled: true }),
      },
    );
    expect(ok.status).toBe(200);
    expect(checkoutSpy).toHaveBeenCalledWith(sessionId, "leaf-b", {
      discardUnsettled: true,
    });
    expect(await ok.json()).toMatchObject({
      activeNodeId: "leaf-b",
      branchEpoch: 2,
    });
  });

  it("rejects submit_actions.payload.branchFromNodeId during pre-registration admission without side effects", async () => {
    const ensureEmbeddingLock = vi.fn(async () => {});
    const actionApp = createApp(store, { ensureEmbeddingLock });

    const missingNodeRes = await actionApp.request("/api/actions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "req-missing",
        sessionId,
        type: "submit_actions",
        payload: {
          actions: [{ kind: "say", text: "What if?" }],
          branchFromNodeId: "other-root",
        },
      }),
    });
    expect(missingNodeRes.status).toBe(200);
    const missingEvents = parseSseEvents(await missingNodeRes.text());
    expect(missingEvents).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "error.occurred",
          payload: expect.objectContaining({ code: "branch_node_not_found" }),
        }),
      }),
    );

    const validNodeRes = await actionApp.request("/api/actions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "req-valid",
        sessionId,
        type: "submit_actions",
        payload: {
          actions: [{ kind: "say", text: "What if?" }],
          branchFromNodeId: "branch-a",
        },
      }),
    });
    expect(validNodeRes.status).toBe(200);
    const validEvents = parseSseEvents(await validNodeRes.text());
    expect(validEvents).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "error.occurred",
          payload: expect.objectContaining({
            code: "branch_checkout_required",
          }),
        }),
      }),
    );

    expect(ensureEmbeddingLock).not.toHaveBeenCalled();
    expect(await store.listMessages(sessionId)).toHaveLength(0);
  });
});
