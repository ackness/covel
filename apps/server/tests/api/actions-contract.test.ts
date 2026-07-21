/**
 * POST /api/actions — action-type contract tests.
 *
 *
 * - `trigger_event` was a dead pipeline: its payload (eventType/eventData)
 *   was never read server-side and no UI called it — the request just
 *   re-ran a full turn. The action type is removed; requests must get a
 *   400, not a silent whole-turn execution.
 * - `retry_runtime` ignored `payload.runtimeId` and re-ran the whole turn.
 *   It now honors the runtimeId via the manual-trigger path (scoped rerun);
 *   omitting runtimeId keeps the historical whole-turn-retry semantics.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { createMemoryStore, type DataStore } from "@covel/store";
import { createEventBus } from "@covel/events";
import {
  createPluginRegistry,
  type PluginRegistry,
  type PluginRegistryEntry,
  type PluginSummary,
  type LoadedRuntime,
} from "@covel/plugin-loader";
import { actionRoutes } from "../../src/routes/api/actions.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { makeFakeLLM, makeFakeLoadedRuntime } from "./__helpers/fake-llm.js";

function makeSummary(overrides: Partial<PluginSummary> = {}): PluginSummary {
  return {
    id: "test-runtime",
    name: "Test Runtime",
    description: "",
    pluginType: "plugin",
    runtimeCount: 1,
    ...overrides,
  };
}

function makeEntry(args: {
  id: string;
  loaded: LoadedRuntime;
}): PluginRegistryEntry {
  const parsed = {
    manifest: args.loaded.manifest,
    promptTemplate: args.loaded.promptTemplate,
    rawFrontmatter: {},
  };
  return {
    id: args.id,
    summary: makeSummary({ id: args.id, name: args.id }),
    manifest: parsed,
    manifests: [parsed],
    loadedRuntimes: new Map([[args.loaded.manifest.name, args.loaded]]),
    status: "registered",
  } as PluginRegistryEntry;
}

async function drainStream(res: Response): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
}

describe("POST /api/actions — action type contract ", () => {
  let store: DataStore;
  let registry: PluginRegistry;
  let app: Hono;
  let loadedByName: Map<string, LoadedRuntime>;
  const sessionId = "sess-contract";
  const NARRATOR_ID = "fake-narrator";
  const SIDE_ID = "fake-side";

  beforeEach(async () => {
    store = createMemoryStore();
    registry = createPluginRegistry();

    const narrator = makeFakeLoadedRuntime({
      name: NARRATOR_ID,
      pluginId: NARRATOR_ID,
      outputKind: "story",
    });
    const side = makeFakeLoadedRuntime({
      name: SIDE_ID,
      pluginId: SIDE_ID,
      outputKind: "system",
    });
    loadedByName = new Map([
      [NARRATOR_ID, narrator],
      [SIDE_ID, side],
    ]);
    registry.register(makeEntry({ id: NARRATOR_ID, loaded: narrator }));
    registry.register(makeEntry({ id: SIDE_ID, loaded: side }));

    await store.createSession({
      id: sessionId,
      worldId: null,
      status: "active",
      presetId: null,
      activePlugins: [NARRATOR_ID, SIDE_ID],
      turnCount: 1,
      preGameCompleted: [],
      createdAt: new Date().toISOString(),
    });

    const eventBus = createEventBus(store);
    const { llm } = makeFakeLLM("A fake reply.");
    const sessionLock = createInProcessSessionLock();

    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("store", store);
      c.set("pluginRegistry", registry);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      c.set("llmAdapter", llm as any);
      c.set("loadRuntimeFn", async (m) => loadedByName.get(m.name));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      c.set("toolExecutor", undefined as any);
      c.set("resolveModel", () => undefined);
      c.set("eventBus", eventBus);
      c.set("sessionLock", sessionLock);
      await next();
    });
    app.route("/api/actions", actionRoutes);
  });

  it("rejects the removed trigger_event action with 400", async () => {
    const res = await app.request("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-te",
        type: "trigger_event",
        sessionId,
        payload: { eventType: "custom.event", eventData: {} },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("Unsupported action type");
  });

  it("retry_runtime with runtimeId re-runs only that runtime (manual path)", async () => {
    const res = await app.request("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-retry-scoped",
        type: "retry_runtime",
        sessionId,
        payload: { runtimeId: SIDE_ID },
      }),
    });
    expect(res.status).toBe(200);
    await drainStream(res);

    const results = await store.listTurnResults(sessionId);
    const ranRuntimeIds = results.flatMap((r) =>
      (r.runtimeResults as { runtimeId: string }[]).map((rr) => rr.runtimeId),
    );
    expect(ranRuntimeIds).toContain(SIDE_ID);
    expect(ranRuntimeIds).not.toContain(NARRATOR_ID);
  });

  it("scoped retry_runtime does not advance turnCount", async () => {
    // Rerunning one runtime over the same logical turn is not a new player
    // turn. It used to be stamped origin=player and committed, so retrying
    // pushed turnCount a second time (UI turn number / snapshot cadence drift).
    const before = (await store.getSession(sessionId))!.turnCount;
    const res = await app.request("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-retry-count",
        type: "retry_runtime",
        sessionId,
        payload: { runtimeId: SIDE_ID },
      }),
    });
    expect(res.status).toBe(200);
    await drainStream(res);

    const after = (await store.getSession(sessionId))!.turnCount;
    expect(after).toBe(before);

    // The rerun's persisted row is stamped non-player origin.
    const results = await store.listTurnResults(sessionId);
    const retryRow = results.find(
      (r) =>
        (r.runtimeResults as { runtimeId: string }[]).some(
          (rr) => rr.runtimeId === SIDE_ID,
        ) && r.origin === "manual",
    );
    expect(retryRow).toBeDefined();
  });

  it("rejects start_session for a session with no active plugins", async () => {
    // An empty plugin set used to mean "activate every registered plugin",
    // which pulled in plugins the player never chose — including mutually
    // exclusive narrative engines — and persisted that for the session's life.
    // The plugin set is chosen at session creation; an empty one is a caller
    // bug, not a request for the whole catalogue.
    const emptySessionId = "sess-no-plugins";
    await store.createSession({
      id: emptySessionId,
      worldId: null,
      status: "active",
      presetId: null,
      activePlugins: [],
      turnCount: 0,
      preGameCompleted: [],
      createdAt: new Date().toISOString(),
    });

    const res = await app.request("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-empty-plugins",
        type: "start_session",
        sessionId: emptySessionId,
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("no active plugins");
    // No turn ran, so nothing was persisted for the session.
    expect(await store.listTurnResults(emptySessionId)).toHaveLength(0);
  });

  it("retry_runtime without runtimeId keeps whole-turn-retry semantics", async () => {
    const res = await app.request("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-retry-full",
        type: "retry_runtime",
        sessionId,
        payload: {},
      }),
    });
    expect(res.status).toBe(200);
    await drainStream(res);

    const results = await store.listTurnResults(sessionId);
    const ranRuntimeIds = results.flatMap((r) =>
      (r.runtimeResults as { runtimeId: string }[]).map((rr) => rr.runtimeId),
    );
    expect(ranRuntimeIds).toContain(NARRATOR_ID);
  });
});
