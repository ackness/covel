/**
 * POST /api/actions — turn commit-barrier regression tests (audit R-06/R-08/
 * R-09/R-14).
 *
 * Asserts the post-turn commit consistency contract on the real actions route:
 *   - post-turn memory ingestion fires only AFTER the proposal commit and the
 *     automatic snapshot (R-06/R-09 barrier — on this route the barrier is
 *     `TurnResult.completeTurn`, invoked after commit + snapshot; note the
 *     actions route does not thread an eventBus into executeTurn, so the
 *     bus-level turn.completed is exercised by the runtime-level tests);
 *   - every trace_events row of the turn shares the single SSE traceId —
 *     recorder, emitter, and commit-pipeline rows alike (R-14).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { createMemoryStore, type DataStore } from "@covel/store";
import { createEventBus, type SubscriptionEvent } from "@covel/events";
import {
  createPluginRegistry,
  type PluginRegistry,
  type PluginRegistryEntry,
  type PluginSummary,
  type LoadedRuntime,
} from "@covel/plugin-loader";
import { actionRoutes, setMemorySystem } from "../../src/routes/api/actions.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { makeFakeLLM, makeFakeLoadedRuntime } from "./__helpers/fake-llm.js";

const SESSION_ID = "sess-barrier";
const RUNTIME_ID = "fake-narrator";

function makeSummary(overrides: Partial<PluginSummary> = {}): PluginSummary {
  return {
    id: RUNTIME_ID,
    name: RUNTIME_ID,
    description: "",
    pluginType: "plugin",
    runtimeCount: 1,
    ...overrides,
  };
}

function makeEntry(loaded: LoadedRuntime): PluginRegistryEntry {
  const parsed = {
    manifest: loaded.manifest,
    promptTemplate: loaded.promptTemplate,
    rawFrontmatter: {},
  };
  return {
    id: loaded.manifest.pluginId,
    summary: makeSummary({ id: loaded.manifest.pluginId }),
    manifest: parsed,
    manifests: [parsed],
    loadedRuntimes: new Map([[loaded.manifest.name, loaded]]),
    status: "registered",
  } as PluginRegistryEntry;
}

/** Drain the actions SSE stream, returning the parsed envelopes. */
async function drainActionStream(res: Response): Promise<
  Array<{
    type: string;
    traceId?: string;
    payload?: Record<string, unknown>;
  }>
> {
  const envelopes: Array<{
    type: string;
    traceId?: string;
    payload?: Record<string, unknown>;
  }> = [];
  if (!res.body) return envelopes;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        envelopes.push(JSON.parse(line.slice(6)));
      } catch {
        // ignore non-JSON SSE lines
      }
    }
  }
  return envelopes;
}

describe("POST /api/actions — turn commit barrier", () => {
  let store: DataStore;
  let registry: PluginRegistry;
  let app: Hono;
  let busEvents: SubscriptionEvent[];
  let memoryCalls: Array<{ busTypesAtCall: string[] }>;

  beforeEach(async () => {
    store = createMemoryStore();
    registry = createPluginRegistry();
    registry.register(makeEntry(makeFakeLoadedRuntime({ name: RUNTIME_ID })));

    // turnCount 0 with no turn_results rows: this turn advances the counter
    // to 1, which is always an auto-snapshot checkpoint (turnCount <= 1
    // bypasses the cadence gate), so the barrier assertions below can rely on
    // a snapshot existing.
    await store.createSession({
      id: SESSION_ID,
      worldId: null,
      status: "active",
      presetId: null,
      activePlugins: [RUNTIME_ID],
      turnCount: 0,
      preGameCompleted: [],
      createdAt: new Date().toISOString(),
    });
    // Prime one prior player message so turnNumber >= 1 and the main-loop
    // priority-500 runtime survives the Pre-Game band filter.
    await store.appendTurnMessage({
      id: "prior-player-0",
      sessionId: SESSION_ID,
      turnId: "prior-turn",
      sourceType: "player",
      role: "user",
      content: "prior turn",
      order: 0,
      createdAt: "2024-01-01T00:00:00Z",
    });

    const eventBus = createEventBus(store);
    busEvents = [];
    eventBus.onEmit((e) => busEvents.push(e));

    // Memory system mock — records the bus events visible at ingestion time,
    // so tests can prove ingestion ran after the snapshot (commit barrier).
    memoryCalls = [];
    setMemorySystem({
      manager: {
        loadBlocks: async () => [
          { label: "persona", content: "seed", updatedAt: "2024-01-01" },
        ],
        initializeDefaults: async () => {},
      },
      updater: {
        updateAfterTurn: async () => {
          memoryCalls.push({
            busTypesAtCall: busEvents.map((e) => e.type as string),
          });
          return { updated: true, blocksChanged: [] };
        },
      },
    });

    const { llm } = makeFakeLLM("A committed narrative line.");
    const sessionLock = createInProcessSessionLock();
    const loaded = makeFakeLoadedRuntime({ name: RUNTIME_ID });

    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("store", store);
      c.set("pluginRegistry", registry);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      c.set("llmAdapter", llm as any);
      c.set("loadRuntimeFn", async () => loaded);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      c.set("toolExecutor", undefined as any);
      c.set("resolveModel", () => undefined);
      c.set("eventBus", eventBus);
      c.set("sessionLock", sessionLock);
      await next();
    });
    app.route("/api/actions", actionRoutes);
  });

  async function runTurn(): Promise<Array<{ type: string; traceId?: string }>> {
    const res = await app.request("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-barrier",
        type: "send_message",
        sessionId: SESSION_ID,
        payload: { content: "hello" },
      }),
    });
    expect(res.status).toBe(200);
    return drainActionStream(res);
  }

  it("gates post-turn memory ingestion behind commit + snapshot (R-06/R-09)", async () => {
    const envelopes = await runTurn();
    expect(envelopes.map((e) => e.type)).not.toContain("error.occurred");

    // completeTurn() schedules ingestion fire-and-forget — let it settle.
    await new Promise((resolve) => setImmediate(resolve));
    expect(memoryCalls).toHaveLength(1);
    // At ingestion time the auto snapshot had already been captured, i.e. the
    // barrier fired after commit + snapshot, not during execution.
    expect(memoryCalls[0].busTypesAtCall).toContain("state.snapshot.created");

    const snapshots = await store.listSnapshots(SESSION_ID);
    expect(snapshots.length).toBeGreaterThan(0);
  });

  it("persists every trace row of the turn under the single SSE traceId (R-14)", async () => {
    const envelopes = await runTurn();
    const sseTraceId = envelopes.find((e) => e.traceId)?.traceId;
    expect(sseTraceId).toBeTruthy();

    const rows = await store.listTraceEvents(SESSION_ID);
    expect(rows.length).toBeGreaterThan(0);
    const traceIds = new Set(rows.map((r) => r.traceId));
    // Recorder (turn.started/turn.completed), emitter, and commit-pipeline
    // (proposal.committed) rows all share the SSE stream's traceId.
    expect([...traceIds]).toEqual([sseTraceId]);
    expect(rows.some((r) => r.type === "proposal.committed")).toBe(true);
    expect(rows.some((r) => r.type === "turn.started")).toBe(true);
    expect(rows.some((r) => r.type === "turn.completed")).toBe(true);
  });
});

describe("POST /api/actions — turn accounting follows the commit outcome", () => {
  it("does not advance turnCount when the turn's proposals fail to commit", async () => {
    const store = createMemoryStore();
    const registry = createPluginRegistry();
    registry.register(makeEntry(makeFakeLoadedRuntime({ name: RUNTIME_ID })));
    setMemorySystem(undefined);

    await store.createSession({
      id: SESSION_ID,
      worldId: null,
      status: "active",
      presetId: null,
      activePlugins: [RUNTIME_ID],
      turnCount: 1,
      preGameCompleted: [],
      createdAt: new Date().toISOString(),
    });
    // A prior completed player turn: turn accounting must count history
    // exactly once, and the failing turn below must not add to it.
    await store.saveTurnResult({
      id: "tr-prior",
      sessionId: SESSION_ID,
      turnId: "turn-prior",
      runtimeResults: [{ runtimeId: RUNTIME_ID, output: {} }],
      origin: "player",
      commitStatus: "committed",
      durationMs: 1,
      createdAt: "2024-01-01T00:00:00Z",
    });

    // Veto every commit via a PreStateCommit abort: the handler returns
    // `{ committed: false }` without throwing, which is the proposal-failure
    // path (a thrown store error would instead abort the whole turn as
    // `error.occurred`).
    let vetoEnabled = true;
    const vetoPipeline = {
      run: async (event: string) =>
        vetoEnabled && event === "PreStateCommit"
          ? { action: "abort", reason: "injected commit veto" }
          : { action: "continue" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const eventBus = createEventBus(store);
    const { llm } = makeFakeLLM("A narrative line that will fail to commit.");
    const sessionLock = createInProcessSessionLock();
    const loaded = makeFakeLoadedRuntime({ name: RUNTIME_ID });

    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("store", store);
      c.set("pluginRegistry", registry);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      c.set("llmAdapter", llm as any);
      c.set("loadRuntimeFn", async () => loaded);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      c.set("toolExecutor", undefined as any);
      c.set("resolveModel", () => undefined);
      c.set("eventBus", eventBus);
      c.set("sessionLock", sessionLock);
      c.set("hookPipeline", vetoPipeline);
      await next();
    });
    app.route("/api/actions", actionRoutes);

    const res = await app.request("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-fail-commit",
        type: "send_message",
        sessionId: SESSION_ID,
        payload: { content: "hello" },
      }),
    });
    expect(res.status).toBe(200);
    const envelopes = await drainActionStream(res);
    expect(envelopes.map((e) => e.type)).toContain("proposal.failed");
    const terminal = envelopes.find((e) => e.type === "execution.completed");
    expect(terminal?.payload?.committed).toBe(false);
    expect(String(terminal?.payload?.error)).toContain("injected commit veto");

    // The failed execution persisted its artifact, settled as failed…
    const failedTurn = (await store.listTurnResults(SESSION_ID)).find(
      (tr) => tr.turnId !== "turn-prior",
    );
    expect(failedTurn?.commitStatus).toBe("failed");

    // …and a failed player execution is NOT a completed player turn: the
    // counter that drives the UI turn display and auto-snapshot cadence must
    // stay where it was.
    const session = await store.getSession(SESSION_ID);
    expect(session?.turnCount).toBe(1);

    // Player/runtime conversation messages share the proposal transaction.
    // This test seeded only a turn-result artifact, so no conversation rows
    // survive the failed turn.
    expect(
      (await store.listTurnMessages(SESSION_ID)).map((message) => message.id),
    ).toEqual([]);
    expect(await store.listMessages(SESSION_ID)).toEqual([]);
    expect(await store.listInteractionRecords(SESSION_ID)).toEqual([]);

    // A non-proposal transaction failure has no proposal.failed frame, so the
    // terminal envelope itself must carry the generic finalizer error.
    vetoEnabled = false;
    Object.defineProperty(store, "withTransaction", {
      configurable: true,
      value: async () => {
        throw new Error("injected transaction failure");
      },
    });
    const genericFailureResponse = await app.request("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-fail-transaction",
        type: "send_message",
        sessionId: SESSION_ID,
        payload: { content: "hello again" },
      }),
    });
    const genericFailureEnvelopes = await drainActionStream(
      genericFailureResponse,
    );
    expect(genericFailureEnvelopes.map((e) => e.type)).not.toContain(
      "proposal.failed",
    );
    const genericTerminal = genericFailureEnvelopes.find(
      (e) => e.type === "execution.completed",
    );
    expect(genericTerminal?.payload?.committed).toBe(false);
    expect(String(genericTerminal?.payload?.error)).toContain(
      "injected transaction failure",
    );
  });
});
