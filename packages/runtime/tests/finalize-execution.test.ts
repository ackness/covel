/**
 * Whole-execution finalize primitive tests.
 *
 * `finalizeExecution` is the shared commit boundary for a completed execution's
 * runtime results. It wraps the FULL set of results in one
 * `store.withTransaction`: a proposal failure rolls the whole execution back,
 * except that optional runtimes next to a committed story roll back alone in
 * their own savepoint. These tests pin that boundary on the real MemoryStore,
 * which rolls back via snapshot restore.
 */

import { describe, it, expect } from "vitest";
import { type DataStore } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import type { SuspensionRecord } from "@covel/store";
import type { Proposal, RuntimeEffects } from "@covel/shared";
import { withPendingProposals } from "@covel/tools";
import { createEventBus } from "@covel/events";
import type { TurnEmitter } from "../src/trace/turn-emitter.js";
import { finalizeExecution } from "../src/commit/finalize-execution.js";
import { createHookPipeline } from "../src/hooks/pipeline.js";

const SESSION_ID = "sess-finalize";
const TURN_ID = "turn-finalize";

type ResultOutput = Record<string, unknown>;

interface RuntimeManifestLite {
  readonly name: string;
  readonly pluginId: string;
  readonly outputKind: string;
  readonly capabilities: readonly string[];
}

function makeRuntime(name: string, outputKind = "plugin"): RuntimeManifestLite {
  return { name, pluginId: name, outputKind, outputContract: undefined };
}

function makeResult(
  runtimeId: string,
  output: ResultOutput = {},
  effects?: RuntimeEffects,
) {
  return {
    pluginId: runtimeId,
    runtimeId,
    runId: crypto.randomUUID(),
    turnId: TURN_ID,
    status: "success" as const,
    output,
    effects,
    toolCalls: [] as const,
    durationMs: 1,
    timestamp: new Date().toISOString(),
  };
}

function makeSuspension(): SuspensionRecord {
  return {
    id: "suspension-finalize",
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    runtimeId: "rt-a",
    pluginId: "rt-a",
    reason: "wait",
    resumeSchema: {},
    pendingContinuation: {
      executionContext: {
        executionId: crypto.randomUUID(),
        origin: "player",
        countPolicy: "complete-player-turn",
        logicalTurnId: crypto.randomUUID(),
      },
      messages: [],
      toolCallsSoFar: [],
      pendingProposals: [],
    },
    createdAt: "2026-08-26T00:00:00.000Z",
  };
}

/** A state.patch that commits; assert via `getStateEntry`. */
function statePatch(field: string, value: unknown): RuntimeEffects {
  return { statePatches: [{ table: "stats", field, value }] };
}

/** A state.patch missing `table` — the handler rejects it with `{ committed: false }`. */
function badStatePatch(): RuntimeEffects {
  return { statePatches: [{ field: "hp", value: 1 }] };
}

function makeRecordingEmitter(): {
  emitter: TurnEmitter;
  emits: Array<{ type: string; payload: Record<string, unknown> }>;
} {
  const emits: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const emitter = {
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    traceId: "trace-finalize",
    async emit(type: string, payload: Record<string, unknown>) {
      emits.push({ type, payload });
    },
  } as unknown as TurnEmitter;
  return { emitter, emits };
}

async function savePendingTurn(store: DataStore): Promise<void> {
  await store.saveTurnResult({
    id: crypto.randomUUID(),
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    runtimeResults: [],
    origin: "player",
    commitStatus: "pending",
    durationMs: 1,
    createdAt: new Date().toISOString(),
  });
}

async function commitStatusOf(store: DataStore): Promise<string | undefined> {
  const rows = await store.listTurnResults(SESSION_ID);
  return rows.find((r) => r.turnId === TURN_ID)?.commitStatus;
}

describe("finalizeExecution", () => {
  it.each([false, true])(
    "publishes manual interactions only after a successful commit (rollback=%s)",
    async (rollback) => {
      const store = createMemoryStore();
      await savePendingTurn(store);
      const eventBus = createEventBus();
      const events: Array<Record<string, unknown>> = [];
      eventBus.onEmit((event) => {
        if (event.topic === "state")
          events.push({ ...event.payload, type: event.type });
      });
      const outcome = await finalizeExecution({
        store,
        sessionId: SESSION_ID,
        eventBus,
        executionContext: {
          executionId: TURN_ID,
          origin: "manual",
          countPolicy: "none",
        },
        runtimes: [makeRuntime("form")],
        results: [
          makeResult(
            "form",
            {},
            {
              interactions: [
                { interactionId: "check", type: "form", fields: [] },
              ],
            },
          ),
        ],
        turnIds: [TURN_ID],
        extraInTx: async () => {
          expect(events).toEqual([]);
          if (rollback) throw new Error("Rollback after form persistence");
        },
      });
      expect(outcome.status).toBe(rollback ? "failed" : "committed");
      expect(events).toHaveLength(rollback ? 0 : 1);
      if (!rollback)
        expect(events[0]).toMatchObject({
          type: "interaction.requested",
          turnId: TURN_ID,
          block: { data: { interactionId: "check" } },
        });
      await store.close();
    },
  );

  it.each(["before", "during"])(
    "rolls back a completed story when stopped %s finalization",
    async (when) => {
      const store = createMemoryStore();
      await savePendingTurn(store);
      const controller = new AbortController();
      if (when === "before") controller.abort();
      const outcome = await finalizeExecution({
        store,
        signal: controller.signal,
        sessionId: SESSION_ID,
        executionContext: {
          executionId: TURN_ID,
          origin: "player",
          countPolicy: "none",
        },
        runtimes: [makeRuntime("story", "story"), makeRuntime("tracker")],
        results: [
          makeResult("story", { narrativeOutput: "A complete, valid scene." }),
          makeResult("tracker", {}, statePatch("hp", 99)),
        ],
        turnIds: [TURN_ID],
        extraInTx: async () => {
          controller.abort();
        },
      });
      expect(outcome.status).toBe("failed");
      expect(outcome.events).toEqual([]);
      expect(await store.getStateEntry(SESSION_ID, "stats", "hp")).toBeNull();
      expect(await store.listTurnMessages(SESSION_ID)).toEqual([]);
      expect(await commitStatusOf(store)).toBe("failed");
    },
  );
  it("publishes turn.suspended only after its continuation commits", async () => {
    const store = createMemoryStore();
    await savePendingTurn(store);
    const eventBus = createEventBus();
    const events: Array<{
      type: string;
      payload: Record<string, unknown>;
    }> = [];
    eventBus.onEmit((event) =>
      events.push({ type: event.type, payload: event.payload }),
    );

    const outcome = await finalizeExecution({
      executionContext: {
        executionId: crypto.randomUUID(),
        origin: "manual",
        countPolicy: "none",
      },
      store,
      sessionId: SESSION_ID,
      runtimes: [makeRuntime("rt-a")],
      results: [makeResult("rt-a", {})],
      suspensions: [makeSuspension()],
      turnIds: [TURN_ID],
      eventBus,
    });

    expect(outcome.status).toBe("committed");
    expect(await store.listSuspensions(SESSION_ID)).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn.suspended",
        payload: expect.objectContaining({
          suspensionId: "suspension-finalize",
        }),
      }),
    );
  });

  it("rolls a continuation back without publishing turn.suspended", async () => {
    const store = createMemoryStore();
    await savePendingTurn(store);
    const eventBus = createEventBus();
    const events: Array<{
      type: string;
      payload: Record<string, unknown>;
    }> = [];
    eventBus.onEmit((event) =>
      events.push({ type: event.type, payload: event.payload }),
    );

    const outcome = await finalizeExecution({
      executionContext: {
        executionId: crypto.randomUUID(),
        origin: "manual",
        countPolicy: "none",
      },
      store,
      sessionId: SESSION_ID,
      runtimes: [makeRuntime("rt-a")],
      results: [makeResult("rt-a", {}, badStatePatch())],
      suspensions: [makeSuspension()],
      turnIds: [TURN_ID],
      eventBus,
    });

    expect(outcome.status).toBe("failed");
    expect(await store.listSuspensions(SESSION_ID)).toHaveLength(0);
    expect(events.map((event) => event.type)).not.toContain("turn.suspended");
  });

  it("rolls the whole execution back when a later runtime's proposal fails", async () => {
    const store = createMemoryStore();
    await savePendingTurn(store);
    const { emitter, emits } = makeRecordingEmitter();

    // Runtime A commits several explicit effects; runtime B's malformed patch
    // causes the entire transaction to roll back.
    const outcome = await finalizeExecution({
      executionContext: {
        executionId: crypto.randomUUID(),
        origin: "manual",
        countPolicy: "none",
      },
      store,
      sessionId: SESSION_ID,
      runtimes: [makeRuntime("rt-a"), makeRuntime("rt-b")],
      results: [
        makeResult(
          "rt-a",
          {},
          {
            ...statePatch("hp", 42),
            events: [{ topic: "stats.changed", data: { hp: 42 } }],
            pluginData: [
              { namespace: "entries", key: "rollback", value: { hp: 42 } },
            ],
          },
        ),
        makeResult("rt-b", {}, badStatePatch()),
      ],
      turnIds: [TURN_ID],
      emitter,
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.events).toHaveLength(0);
    expect(outcome.failedProposals).toHaveLength(1);
    expect(outcome.failedProposals[0].error).toMatch(
      /table must be a non-empty string/,
    );

    // The committed sibling's write is rolled back — DB has no trace of it.
    expect(await store.getStateEntry(SESSION_ID, "stats", "hp")).toBeNull();
    expect(await store.listEvents(SESSION_ID)).toEqual([]);
    expect(
      await store.getPluginData(SESSION_ID, "rt-a", "entries", "rollback"),
    ).toBeNull();
    // The execution's turn_results row is settled failed.
    expect(await commitStatusOf(store)).toBe("failed");
    // No post-commit fan-out leaked for the rolled-back sibling.
    expect(emits).toHaveLength(0);
  });

  it("does not commit typed plugin events as domain events", async () => {
    const store = createMemoryStore();
    await savePendingTurn(store);

    const outcome = await finalizeExecution({
      executionContext: {
        executionId: crypto.randomUUID(),
        origin: "manual",
        countPolicy: "none",
      },
      store,
      sessionId: SESSION_ID,
      runtimes: [makeRuntime("world-ir")],
      results: [
        makeResult("world-ir", {
          events: [
            {
              id: "found-brass-key",
              type: "inventory_change",
              participantIds: ["player", "brass-key"],
            },
          ],
        }),
      ],
      turnIds: [TURN_ID],
    });

    expect(outcome.status).toBe("committed");
    expect(outcome.failedProposals).toEqual([]);
    expect(await store.listEvents(SESSION_ID)).toEqual([]);
    expect(await commitStatusOf(store)).toBe("committed");
  });

  it("commits execution journal messages with successful proposals", async () => {
    const store = createMemoryStore();
    await savePendingTurn(store);

    const outcome = await finalizeExecution({
      executionContext: {
        executionId: crypto.randomUUID(),
        origin: "manual",
        countPolicy: "none",
      },
      store,
      sessionId: SESSION_ID,
      runtimes: [makeRuntime("rt-a")],
      results: [makeResult("rt-a", {}, statePatch("hp", 10))],
      turnIds: [TURN_ID],
      journalMessages: [
        {
          id: "msg-player",
          sessionId: SESSION_ID,
          turnId: TURN_ID,
          sourceType: "player",
          role: "user",
          content: "advance",
          order: 0,
          createdAt: "2026-08-09T00:00:00.000Z",
        },
        {
          id: "msg-runtime",
          sessionId: SESSION_ID,
          turnId: TURN_ID,
          sourceType: "runtime",
          sourcePluginId: "rt-a",
          sourceRuntimeId: "rt-a",
          role: "assistant",
          content: "done",
          order: 500,
          createdAt: "2026-08-09T00:00:01.000Z",
        },
      ],
    });

    expect(outcome.status).toBe("committed");
    expect(
      (await store.listTurnMessages(SESSION_ID)).map((message) => message.id),
    ).toEqual(["msg-player", "msg-runtime"]);
  });

  it("rolls execution journal messages back with a failed proposal", async () => {
    const store = createMemoryStore();
    await savePendingTurn(store);

    const outcome = await finalizeExecution({
      executionContext: {
        executionId: crypto.randomUUID(),
        origin: "manual",
        countPolicy: "none",
      },
      store,
      sessionId: SESSION_ID,
      runtimes: [makeRuntime("rt-a")],
      results: [makeResult("rt-a", {}, badStatePatch())],
      turnIds: [TURN_ID],
      journalMessages: [
        {
          id: "msg-rolled-back",
          sessionId: SESSION_ID,
          turnId: TURN_ID,
          sourceType: "runtime",
          sourcePluginId: "rt-a",
          sourceRuntimeId: "rt-a",
          role: "assistant",
          content: "ghost",
          order: 500,
          createdAt: "2026-08-09T00:00:00.000Z",
        },
      ],
    });

    expect(outcome.status).toBe("failed");
    expect(await store.listTurnMessages(SESSION_ID)).toEqual([]);
  });

  it("commits the whole execution in one transaction and flushes deferred fan-out in order", async () => {
    const store = createMemoryStore();
    await savePendingTurn(store);
    const { emitter, emits } = makeRecordingEmitter();

    const outcome = await finalizeExecution({
      executionContext: {
        executionId: crypto.randomUUID(),
        origin: "manual",
        countPolicy: "none",
      },
      store,
      sessionId: SESSION_ID,
      runtimes: [makeRuntime("rt-a"), makeRuntime("rt-b")],
      results: [
        makeResult("rt-a", {}, statePatch("hp", 10)),
        makeResult("rt-b", {}, statePatch("mp", 20)),
      ],
      turnIds: [TURN_ID],
      emitter,
    });

    expect(outcome.status).toBe("committed");
    expect(outcome.failedProposals).toHaveLength(0);
    expect(outcome.events.map((e) => e.type)).toEqual([
      "state.changed",
      "state.changed",
    ]);

    // Both writes landed.
    expect((await store.getStateEntry(SESSION_ID, "stats", "hp"))?.value).toBe(
      10,
    );
    expect((await store.getStateEntry(SESSION_ID, "stats", "mp"))?.value).toBe(
      20,
    );
    expect(await commitStatusOf(store)).toBe("committed");

    // Deferred fan-out flushed after commit, in proposal (runtime) order.
    expect(emits.map((e) => e.type)).toEqual([
      "state.patch.applied",
      "state.patch.applied",
    ]);
    expect(
      emits.map((e) => (e.payload.patch as { summary: string }).summary),
    ).toEqual(["hp", "mp"]);
  });

  it("rejects empty story before committing sibling proposals and preserves existing durable state", async () => {
    const store = createMemoryStore();
    await savePendingTurn(store);
    const now = new Date().toISOString();
    await store.setPluginData({
      id: "durable-effect",
      sessionId: SESSION_ID,
      pluginId: "rt-b",
      namespace: "external",
      key: "already-done",
      value: { intact: true },
      createdAt: now,
      updatedAt: now,
    });
    const outcome = await finalizeExecution({
      executionContext: {
        executionId: "failed-story",
        origin: "manual",
        countPolicy: "none",
      },
      store,
      sessionId: SESSION_ID,
      runtimes: [makeRuntime("rt-b"), makeRuntime("rt-a", "story")],
      results: [
        makeResult("rt-b", {}, statePatch("hp", 99)),
        makeResult("rt-a", { toolCalls: [] }),
      ],
      turnIds: [TURN_ID],
    });
    expect(outcome.status).toBe("failed");
    expect(await store.getStateEntry(SESSION_ID, "stats", "hp")).toBeNull();
    expect(
      (
        await store.getPluginData(
          SESSION_ID,
          "rt-b",
          "external",
          "already-done",
        )
      )?.value,
    ).toEqual({ intact: true });
    expect(await commitStatusOf(store)).toBe("failed");
  });

  it("keeps a committed story when an optional sibling's proposal is rejected", async () => {
    const store = createMemoryStore();
    await savePendingTurn(store);

    // Runtime A commits a narrative message; runtime B is rejected by the
    // validator (no throw). Only B's writes are dropped.
    const outcome = await finalizeExecution({
      executionContext: {
        executionId: crypto.randomUUID(),
        origin: "manual",
        countPolicy: "none",
      },
      store,
      sessionId: SESSION_ID,
      runtimes: [makeRuntime("rt-a", "story"), makeRuntime("rt-b")],
      results: [
        makeResult("rt-a", { narrativeOutput: "committed line" }),
        makeResult("rt-b", {}, badStatePatch()),
      ],
      turnIds: [TURN_ID],
    });

    expect(outcome).toMatchObject({
      status: "committed",
      isolatedRuntimes: [{ runtimeId: "rt-b", error: expect.any(String) }],
    });
    expect(outcome.failedProposals).toHaveLength(1);
    expect(await store.listMessages(SESSION_ID)).toHaveLength(1);
    expect(await commitStatusOf(store)).toBe("committed");
  });

  it.each([
    { statePatches: [null] },
    { statePatches: { length: 1 } },
    { interactions: { length: 1 } },
    { notifications: { length: 1 } },
  ])(
    "keeps a committed story when a sibling returns a malformed effect channel: %j",
    async (effects) => {
      const store = createMemoryStore();
      await savePendingTurn(store);
      const story = makeResult("story", { narrativeOutput: "The door opens." });
      const sibling = makeResult(
        "sibling",
        {},
        effects as unknown as RuntimeEffects,
      );
      const result = await finalizeExecution({
        store,
        sessionId: SESSION_ID,
        executionContext: {
          executionId: "malformed-effects",
          origin: "player",
          countPolicy: "none",
        },
        runtimes: [makeRuntime("story", "story"), makeRuntime("sibling")],
        results: [story, sibling],
        turnIds: [TURN_ID],
      });
      expect(result.status).toBe("committed");
      expect(result.isolatedRuntimes).toEqual([
        expect.objectContaining({ runtimeId: "sibling" }),
      ]);
      expect(
        (await store.listMessages(SESSION_ID)).map(
          (message) => message.content,
        ),
      ).toEqual(["The door opens."]);
      expect(await commitStatusOf(store)).toBe("committed");
    },
  );

  it("keeps a committed story when an optional sibling returned a malformed UI part", async () => {
    const store = createMemoryStore();
    await savePendingTurn(store);

    // A null part cannot become a card. It is a rejected write of rt-b, never
    // an exception that takes the story down with it.
    const outcome = await finalizeExecution({
      executionContext: {
        executionId: crypto.randomUUID(),
        origin: "manual",
        countPolicy: "none",
      },
      store,
      sessionId: SESSION_ID,
      runtimes: [makeRuntime("rt-a", "story"), makeRuntime("rt-b")],
      results: [
        makeResult("rt-a", { narrativeOutput: "committed line" }),
        makeResult("rt-b", {}, { ui: [{ parts: [null] }] } as never),
      ],
      turnIds: [TURN_ID],
    });

    expect(outcome).toMatchObject({
      status: "committed",
      isolatedRuntimes: [
        {
          runtimeId: "rt-b",
          error: "effects.ui[0].parts[0] is not an object",
        },
      ],
    });
    expect(await store.listMessages(SESSION_ID)).toHaveLength(1);
    expect(await commitStatusOf(store)).toBe("committed");
  });

  it("keeps a dropped sibling's journal rows and trigger count out", async () => {
    const store = createMemoryStore();
    const now = new Date().toISOString();
    // The trigger ledger records against the session row.
    await store.createSession({
      id: SESSION_ID,
      worldId: null,
      phase: "playing",
      status: "active",
      completedPlayerTurns: 0,
      setupRuntimes: {},
      activePlugins: ["rt-a", "rt-b"],
      createdAt: now,
      updatedAt: now,
    });
    await savePendingTurn(store);
    const journalRow = (runtimeId: string, order: number) => ({
      id: `msg-${runtimeId}`,
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      sourceType: "runtime" as const,
      sourcePluginId: runtimeId,
      sourceRuntimeId: runtimeId,
      role: "assistant" as const,
      content: `${runtimeId} card`,
      order,
      createdAt: "2026-08-09T00:00:01.000Z",
    });

    const outcome = await finalizeExecution({
      executionContext: {
        executionId: crypto.randomUUID(),
        origin: "manual",
        countPolicy: "none",
      },
      store,
      sessionId: SESSION_ID,
      runtimes: [makeRuntime("rt-a", "story"), makeRuntime("rt-b")],
      results: [
        makeResult("rt-a", { narrativeOutput: "committed line" }),
        makeResult("rt-b", {}, badStatePatch()),
      ],
      turnIds: [TURN_ID],
      journalMessages: [journalRow("rt-a", 100), journalRow("rt-b", 500)],
      runtimeTriggers: ["rt-a", "rt-b"],
    });

    expect(outcome.status).toBe("committed");
    expect(
      (await store.listTurnMessages(SESSION_ID)).map((message) => message.id),
    ).toEqual(["msg-rt-a"]);
    const ledger = await store.listPluginData(
      SESSION_ID,
      "__kernel:triggers",
      "runtimes",
    );
    expect(ledger.map((row) => row.key)).toEqual(["rt-a"]);
  });

  it("runs PreStateCommit hooks before opening the transaction", async () => {
    const store = createMemoryStore();
    await savePendingTurn(store);
    const order: string[] = [];
    const withTransaction = store.withTransaction.bind(store);
    store.withTransaction = (fn) => {
      order.push("transaction");
      return withTransaction(fn);
    };
    const hookPipeline = createHookPipeline();
    hookPipeline.register({
      id: "observe",
      event: "PreStateCommit",
      async handler() {
        order.push("hook");
        return { action: "continue" };
      },
    });

    const outcome = await finalizeExecution({
      executionContext: {
        executionId: crypto.randomUUID(),
        origin: "manual",
        countPolicy: "none",
      },
      store,
      sessionId: SESSION_ID,
      runtimes: [makeRuntime("rt-a", "story")],
      results: [makeResult("rt-a", { narrativeOutput: "line" })],
      turnIds: [TURN_ID],
      hookPipeline,
    });

    expect(outcome.status).toBe("committed");
    expect(order).toEqual(["hook", "transaction"]);
  });

  it("rolls back on a handler validation failure when no story committed", async () => {
    const store = createMemoryStore();
    await savePendingTurn(store);

    const outcome = await finalizeExecution({
      executionContext: {
        executionId: crypto.randomUUID(),
        origin: "manual",
        countPolicy: "none",
      },
      store,
      sessionId: SESSION_ID,
      runtimes: [makeRuntime("rt-a"), makeRuntime("rt-b")],
      results: [
        makeResult("rt-a", { narrativeOutput: "plugin line" }),
        makeResult("rt-b", {}, badStatePatch()),
      ],
      turnIds: [TURN_ID],
    });

    expect(outcome.status).toBe("failed");
    expect(await store.listMessages(SESSION_ID)).toHaveLength(0);
    expect(await commitStatusOf(store)).toBe("failed");
  });

  it("rolls back a buffered plugin-data delete when a sibling fails", async () => {
    const store = createMemoryStore();
    await savePendingTurn(store);
    const now = new Date().toISOString();
    await store.setPluginData({
      id: "plugin-row",
      sessionId: SESSION_ID,
      pluginId: "rt-a",
      namespace: "entries",
      key: "keep-me",
      value: { intact: true },
      createdAt: now,
      updatedAt: now,
    });
    const output: ResultOutput = {};
    withPendingProposals(output, [
      {
        id: "delete-proposal",
        type: "plugin.data.delete",
        source: { pluginId: "rt-a", runtimeId: "rt-a" },
        turnId: TURN_ID,
        sessionId: SESSION_ID,
        payload: { namespace: "entries", key: "keep-me" },
        timestamp: now,
      } satisfies Proposal,
    ]);

    const outcome = await finalizeExecution({
      executionContext: {
        executionId: crypto.randomUUID(),
        origin: "manual",
        countPolicy: "none",
      },
      store,
      sessionId: SESSION_ID,
      runtimes: [makeRuntime("rt-a"), makeRuntime("rt-b")],
      results: [
        makeResult("rt-a", output),
        makeResult("rt-b", {}, badStatePatch()),
      ],
      turnIds: [TURN_ID],
    });

    expect(outcome.status).toBe("failed");
    expect(
      await store.getPluginData(SESSION_ID, "rt-a", "entries", "keep-me"),
    ).not.toBeNull();
  });

  it("rolls back the whole execution when extraInTx throws", async () => {
    const store = createMemoryStore();
    await savePendingTurn(store);

    const outcome = await finalizeExecution({
      executionContext: {
        executionId: crypto.randomUUID(),
        origin: "manual",
        countPolicy: "none",
      },
      store,
      sessionId: SESSION_ID,
      runtimes: [makeRuntime("rt-a", "story")],
      results: [makeResult("rt-a", { narrativeOutput: "committed line" })],
      turnIds: [TURN_ID],
      extraInTx: async () => {
        throw new Error("extra boom");
      },
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.error).toMatch(/extra boom/);
    // The proposal committed before extraInTx ran, but the throw rolls it back.
    expect(await store.listMessages(SESSION_ID)).toHaveLength(0);
    expect(await commitStatusOf(store)).toBe("failed");
  });

  describe("job-status terminalisation", () => {
    const EXECUTION_ID = "exec-jobs";
    const executionContext = {
      executionId: EXECUTION_ID,
      origin: "player" as const,
      countPolicy: "none" as const,
    };

    async function seedRunningJob(store: DataStore, runtimeId: string) {
      await store.appendJobStatus({
        sessionId: SESSION_ID,
        progressScopeId: EXECUTION_ID,
        pluginId: runtimeId,
        runtimeId,
        jobId: "job-1",
        state: "running",
        sequence: 1,
        createdAt: new Date().toISOString(),
      });
    }

    async function latestJobState(store: DataStore): Promise<string> {
      const rows = await store.listJobStatus(SESSION_ID, { jobId: "job-1" });
      return rows[rows.length - 1]!.state;
    }

    it("maps a committed execution's unterminated jobs to succeeded", async () => {
      const store = createMemoryStore();
      await savePendingTurn(store);
      await seedRunningJob(store, "rt-a");

      const outcome = await finalizeExecution({
        store,
        sessionId: SESSION_ID,
        executionContext,
        runtimes: [makeRuntime("rt-a")],
        results: [makeResult("rt-a", {}, statePatch("hp", 3))],
        turnIds: [TURN_ID],
      });

      expect(outcome.status).toBe("committed");
      expect(await latestJobState(store)).toBe("succeeded");
    });

    it("fails a rolled-back execution's jobs without touching settled ones", async () => {
      const store = createMemoryStore();
      await savePendingTurn(store);
      await seedRunningJob(store, "rt-a");

      const outcome = await finalizeExecution({
        store,
        sessionId: SESSION_ID,
        executionContext,
        runtimes: [makeRuntime("rt-a")],
        results: [makeResult("rt-a", {}, badStatePatch())],
        turnIds: [TURN_ID],
      });

      expect(outcome.status).toBe("failed");
      // Job-status is append-only and outside the domain transaction: the
      // rollback erases domain writes but the terminal failed marker lands.
      expect(await latestJobState(store)).toBe("failed");
    });
  });
});

describe("finalizeExecution — dependents of a dropped runtime", () => {
  const storyResult = () => makeResult("story", { narrativeOutput: "line" });
  const manifest = (name: string, extra: Record<string, unknown> = {}) => ({
    ...makeRuntime(name),
    ...extra,
  });

  async function finalize(
    runtimes: readonly unknown[],
    results: readonly ReturnType<typeof makeResult>[],
    options: {
      readonly extraInTx?: (
        tx: unknown,
        isolation: { droppedRuntimeIds: ReadonlySet<string> },
      ) => Promise<void>;
      readonly before?: (store: DataStore) => Promise<void>;
    } = {},
  ) {
    const store = createMemoryStore();
    await store.saveTurnResult({
      id: crypto.randomUUID(),
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      runtimeResults: results,
      origin: "player",
      commitStatus: "pending",
      durationMs: 1,
      createdAt: new Date().toISOString(),
    });
    await options.before?.(store);
    const outcome = await finalizeExecution({
      executionContext: {
        executionId: "exec-drop",
        origin: "manual",
        countPolicy: "none",
      },
      store,
      sessionId: SESSION_ID,
      runtimes: [makeRuntime("story", "story"), ...runtimes] as never,
      results: [storyResult(), ...results] as never,
      turnIds: [TURN_ID],
      ...(options.extraInTx ? { extraInTx: options.extraInTx as never } : {}),
    });
    const persisted = (await store.listTurnResults(SESSION_ID))[0]!
      .runtimeResults as { runtimeId: string; status: string }[];
    return {
      store,
      outcome,
      statuses: Object.fromEntries(
        persisted.map((entry) => [entry.runtimeId, entry.status]),
      ),
    };
  }

  it.each(["success", "skipped"] as const)(
    "drops %s results that need a dropped upstream, keeping ordering-only edges",
    async (status) => {
      const { store, outcome, statuses } = await finalize(
        [
          manifest("up"),
          manifest("down", { needs: ["up"] }),
          manifest("late", { after: ["up"] }),
        ],
        [
          makeResult("up", {}, badStatePatch()),
          {
            ...makeResult("down"),
            status,
            pendingProposals: [
              {
                id: "guard-write",
                type: "state.patch" as const,
                sessionId: SESSION_ID,
                turnId: TURN_ID,
                source: { pluginId: "down", runtimeId: "down" },
                timestamp: new Date().toISOString(),
                payload: { table: "stats", field: "derived", value: 2 },
              },
            ],
          },
          makeResult("late", {}, statePatch("late", 3)),
        ],
      );

      expect(outcome).toMatchObject({
        status: "committed",
        isolatedRuntimes: [
          { runtimeId: "up", error: expect.any(String) },
          { runtimeId: "down", error: "upstream up did not commit" },
        ],
      });
      expect(await store.getStateEntry(SESSION_ID, "stats", "derived")).toBe(
        null,
      );
      expect(
        (await store.getStateEntry(SESSION_ID, "stats", "late"))?.value,
      ).toBe(3);
      expect(statuses).toEqual({
        up: "failed",
        down: "failed",
        late: "success",
      });
    },
  );

  it("drops a required input consumer and an event follower whose only emitter was dropped", async () => {
    const { store, outcome } = await finalize(
      [
        manifest("up"),
        manifest("reader", { inputs: { facts: { from: { runtime: "up" } } } }),
        manifest("optional-reader", {
          inputs: { facts: { from: { runtime: "up" }, required: false } },
        }),
        manifest("follower", { trigger: { type: "event", topic: "found" } }),
      ],
      [
        makeResult(
          "up",
          {},
          {
            ...badStatePatch(),
            events: [{ topic: "found", data: {} }],
          },
        ),
        makeResult("reader", {}, statePatch("reader", 1)),
        makeResult("optional-reader", {}, statePatch("optional", 1)),
        makeResult("follower", {}, statePatch("follower", 1)),
      ],
    );

    expect(outcome.isolatedRuntimes?.map((item) => item.runtimeId)).toEqual([
      "up",
      "reader",
      "follower",
    ]);
    expect(
      (await store.getStateEntry(SESSION_ID, "stats", "optional"))?.value,
    ).toBe(1);
    expect(await store.getStateEntry(SESSION_ID, "stats", "follower")).toBe(
      null,
    );
  });

  it.each([
    ["one", "keeps"],
    ["all", "drops"],
  ] as const)(
    "a capability consumer with cardinality %s %s itself when another provider committed",
    async (cardinality, verdict) => {
      const { store } = await finalize(
        [
          manifest("provider-a", { outputContract: "facts@1" }),
          manifest("provider-b", { outputContract: "facts@1" }),
          manifest("consumer", {
            needs: [{ capability: "facts@1", cardinality }],
          }),
        ],
        [
          makeResult("provider-a", {}, badStatePatch()),
          makeResult("provider-b", {}, statePatch("b", 1)),
          makeResult("consumer", {}, statePatch("consumer", 1)),
        ],
      );

      const consumer = await store.getStateEntry(
        SESSION_ID,
        "stats",
        "consumer",
      );
      expect(consumer === null).toBe(verdict === "drops");
    },
  );

  it("rolls the turn back when the story needs a dropped upstream", async () => {
    const store = createMemoryStore();
    await savePendingTurn(store);
    const outcome = await finalizeExecution({
      executionContext: {
        executionId: "exec-story-needs",
        origin: "manual",
        countPolicy: "none",
      },
      store,
      sessionId: SESSION_ID,
      runtimes: [
        manifest("context"),
        { ...makeRuntime("story", "story"), needs: ["context"] },
      ] as never,
      results: [
        makeResult("context", {}, badStatePatch()),
        storyResult(),
      ] as never,
      turnIds: [TURN_ID],
    });

    expect(outcome.status).toBe("failed");
    expect(await store.listMessages(SESSION_ID)).toHaveLength(0);
    expect(await commitStatusOf(store)).toBe("failed");
  });

  it("tells extraInTx which runtimes were dropped and fails their reported jobs", async () => {
    let dropped: readonly string[] = [];
    const { store } = await finalize(
      [manifest("up"), manifest("down", { needs: ["up"] })],
      [
        makeResult("up", {}, badStatePatch()),
        makeResult("down", {}, statePatch("derived", 2)),
      ],
      {
        extraInTx: async (_tx, isolation) => {
          dropped = [...isolation.droppedRuntimeIds];
        },
        before: async (store) => {
          for (const runtimeId of ["up", "down"])
            await store.appendJobStatus({
              sessionId: SESSION_ID,
              progressScopeId: "exec-drop",
              pluginId: runtimeId,
              runtimeId,
              jobId: `${runtimeId}-job`,
              state: "running",
              sequence: 1,
              createdAt: new Date().toISOString(),
            });
        },
      },
    );

    expect(dropped).toEqual(["up", "down"]);
    for (const runtimeId of ["up", "down"]) {
      const rows = await store.listJobStatus(SESSION_ID, {
        jobId: `${runtimeId}-job`,
      });
      expect(rows.at(-1)?.state).toBe("failed");
    }
  });
});
