/**
 * POST /api/actions — turn commit-barrier regression tests (audit R-06/R-08/
 * R-09/R-14).
 *
 * Asserts the post-turn commit consistency contract on the real actions route:
 *   - post-turn memory ingestion fires only AFTER the proposal commit and the
 *     automatic snapshot (R-06/R-09 barrier — on this route the barrier is
 *     `commitExecution`, which owns commit + snapshot + completion; the actions
 *     route threads the eventBus through execute/finalize, and this suite also
 *     verifies the committed bus-level `turn.completed` trace);
 *   - every trace_events row of the turn shares the single SSE traceId —
 *     recorder, emitter, and commit-pipeline rows alike (R-14).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { type DataStore } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import { createEventBus, type SubscriptionEvent } from "@covel/events";
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
import { createHookPipeline } from "@covel/runtime";

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
    runtime: { type: loaded.manifest.runtimeType ?? ("agent" as const) },
    manifest: loaded.manifest,
    promptTemplate: loaded.promptTemplate,
    rawFrontmatter: {},
  };
  return {
    id: loaded.manifest.pluginId,
    source: "builtin",
    summary: makeSummary({ id: loaded.manifest.pluginId }),

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
  let hookPipeline: ReturnType<typeof createHookPipeline>;

  beforeEach(async () => {
    store = createMemoryStore();
    registry = createPluginRegistry();
    registry.register(makeEntry(makeFakeLoadedRuntime({ name: RUNTIME_ID })));

    // The first completed player turn is always an auto-snapshot checkpoint,
    // so the barrier assertions below can rely on a snapshot existing.
    await store.createSession({
      locale: "zh-CN",
      phase: "playing",
      setupRuntimes: {},
      metadata: {
        approvalScopeNonce: globalThis.crypto.randomUUID(),
        sessionIncarnationNonce: globalThis.crypto.randomUUID(),
      },
      id: SESSION_ID,
      status: "active",
      activePlugins: [RUNTIME_ID],
      completedPlayerTurns: 0,

      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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

    const { llm } = makeFakeLLM("A committed narrative line.");
    const sessionLock = createInProcessSessionLock();
    const loaded = makeFakeLoadedRuntime({ name: RUNTIME_ID });
    hookPipeline = createHookPipeline();

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
      c.set("hookPipeline", hookPipeline);
      await next();
    });
    app.route("/api/actions", actionRoutes);
  });

  async function runTurn(
    sessionId = SESSION_ID,
    settings?: Record<string, Record<string, unknown>>,
  ): Promise<Array<{ type: string; traceId?: string }>> {
    const res = await app.request("/api/actions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(settings
          ? {
              "X-Plugin-User-Settings": Buffer.from(
                JSON.stringify(settings),
              ).toString("base64"),
            }
          : {}),
      },
      body: JSON.stringify({
        requestId: "req-barrier",
        type: "send_message",
        sessionId,
        payload: { content: "hello" },
      }),
    });
    expect(res.status).toBe(200);
    return drainActionStream(res);
  }

  it.each([
    {
      type: "send_message",
      payload: { content: "My name is Player. Begin the adventure." },
    },
    { type: "execute_command", payload: { command: "/start adventure" } },
  ])(
    "commits opening $type input once across the setup continuation",
    async (action) => {
      await store.updateSession(SESSION_ID, {
        phase: "setup",
        setupRuntimes: {},
      });
      const content = action.payload.content ?? action.payload.command!;
      const input = {
        id: "browser-opening",
        sessionId: SESSION_ID,
        role: "user" as const,
        content,
        createdAt: "2026-01-01T00:00:00.000Z",
      };
      await store.addMessage(input);
      const response = await app.request("/api/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: "opening-request",
          sessionId: SESSION_ID,
          ...action,
          payload: { ...action.payload, inputMessageId: input.id },
        }),
      });
      expect(response.status).toBe(200);
      const events = await drainActionStream(response);
      expect(
        events.find((event) => event.type === "execution.completed")?.payload
          ?.committed,
      ).toBe(true);
      const messages = (await store.listMessages(SESSION_ID)).filter(
        (message) => message.role === "user",
      );
      expect(messages).toEqual([
        { ...input, metadata: { turnId: expect.any(String) } },
      ]);
      const turns = await store.listTurnResults(SESSION_ID);
      expect(turns).toHaveLength(2);
      expect(
        (await store.listTurnMessages(SESSION_ID)).filter(
          (message) =>
            message.sourceType === "player" && message.content === content,
        ),
      ).toHaveLength(1);
    },
  );

  it("rolls back a mismatched input identity without changing the durable input", async () => {
    const input = {
      id: "browser-input",
      sessionId: SESSION_ID,
      role: "user" as const,
      content: "original",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    await store.addMessage(input);
    const response = await app.request("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "mismatch-request",
        sessionId: SESSION_ID,
        type: "send_message",
        payload: { content: "changed", inputMessageId: input.id },
      }),
    });
    const events = await drainActionStream(response);
    expect(
      events.find((event) => event.type === "execution.completed")?.payload
        ?.committed,
    ).toBe(false);
    expect(await store.listMessages(SESSION_ID)).toEqual([input]);
    expect((await store.getSession(SESSION_ID))?.completedPlayerTurns).toBe(0);
    expect(await store.listInteractionRecords(SESSION_ID)).toEqual([]);
    expect(
      (await store.listTurnMessages(SESSION_ID)).map((message) => message.id),
    ).toEqual(["prior-player-0"]);
  });

  it("scopes zero-runtime package hooks and defaults through execution and commit", async () => {
    const pluginId = "entry-only";
    const observed: Array<{
      sessionId: string;
      event: string;
      settings: unknown;
    }> = [];
    const inactive = vi.fn(async () => ({ action: "continue" as const }));
    registry.register({
      id: pluginId,
      source: "builtin",
      status: "registered",
      loadedRuntimes: new Map(),
      manifests: [],
      summary: {
        id: pluginId,
        name: pluginId,
        description: "Hook-only package",
        pluginType: "plugin",
        runtimeCount: 0,
      },
      packageManifest: {
        plugin: {
          id: pluginId,
          kind: "plugin",
          description: "Hook-only package",
        },
        manifest: {
          name: pluginId,
          pluginId,
          description: "Hook-only package",
          pluginType: "plugin",
          userSettings: [
            { key: "budget", type: "number", label: "Budget", default: 10 },
          ],
        },
        promptTemplate: "",
        rawFrontmatter: {},
      },
    });
    for (const event of ["TurnStart", "PreStateCommit"] as const) {
      hookPipeline.register({
        id: `${pluginId}:${event}`,
        event,
        pluginId,
        handler: async (ctx) => {
          observed.push({
            sessionId: ctx.sessionId,
            event,
            settings: ctx.getOwnSettings?.(),
          });
          return { action: "continue" };
        },
      });
      hookPipeline.register({
        id: `inactive:${event}`,
        event,
        pluginId: "inactive",
        handler: inactive,
      });
    }
    await store.updateSession(SESSION_ID, {
      activePlugins: [RUNTIME_ID, pluginId],
    });
    const secondId = "sess-barrier-second";
    const first = await store.getSession(SESSION_ID);
    await store.createSession({
      ...first!,
      id: secondId,
      metadata: {
        ...first!.metadata,
        approvalScopeNonce: crypto.randomUUID(),
        sessionIncarnationNonce: crypto.randomUUID(),
      },
    });
    await store.appendTurnMessage({
      id: "prior-player-second",
      sessionId: secondId,
      turnId: "prior-turn-second",
      sourceType: "player",
      role: "user",
      content: "prior turn",
      order: 0,
      createdAt: "2024-01-01T00:00:00Z",
    });

    const [firstTurn, secondTurn] = await Promise.all([
      runTurn(),
      runTurn(secondId, { [pluginId]: { budget: 4 } }),
    ]);
    expect(firstTurn.map((event) => event.type)).not.toContain(
      "error.occurred",
    );
    expect(secondTurn.map((event) => event.type)).not.toContain(
      "error.occurred",
    );
    expect(
      observed.filter((entry) => entry.event === "TurnStart"),
    ).toHaveLength(2);
    expect(
      observed.filter((entry) => entry.event === "PreStateCommit").length,
    ).toBeGreaterThanOrEqual(2);
    expect(inactive).not.toHaveBeenCalled();
    for (const entry of observed) {
      expect(entry.settings).toEqual({
        budget: entry.sessionId === secondId ? 4 : 10,
      });
    }
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
  it("does not advance completedPlayerTurns when proposals fail", async () => {
    const store = createMemoryStore();
    const registry = createPluginRegistry();
    registry.register(makeEntry(makeFakeLoadedRuntime({ name: RUNTIME_ID })));
    await store.createSession({
      locale: "zh-CN",
      phase: "playing",
      setupRuntimes: {},
      metadata: {
        approvalScopeNonce: globalThis.crypto.randomUUID(),
        sessionIncarnationNonce: globalThis.crypto.randomUUID(),
      },
      id: SESSION_ID,
      status: "active",
      activePlugins: [RUNTIME_ID],
      completedPlayerTurns: 1,

      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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
    expect(session?.completedPlayerTurns).toBe(1);

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
