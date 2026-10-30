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

import { describe, it, expect, vi } from "vitest";
import { type DataStore } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import type { SuspensionRecord } from "@covel/store";
import type {
  JsonValue,
  Proposal,
  RuntimeEffects,
  RuntimeManifest,
} from "@covel/shared";
import { withPendingProposals } from "@covel/tools";
import { createEventBus } from "@covel/events";
import type { TurnEmitter } from "../src/trace/turn-emitter.js";
import { finalizeExecution } from "../src/commit/finalize-execution.js";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import type { LoadedRuntime } from "@covel/shared/plugin-runtime";
import { commitExecution, executeTurn } from "../src/index.js";

const SESSION_ID = "sess-finalize";
const TURN_ID = "turn-finalize";

type ResultOutput = Record<string, unknown>;

function makeRuntime(
  name: string,
  outputKind: RuntimeManifest["outputKind"] = "system",
): RuntimeManifest {
  return {
    name,
    pluginId: name,
    description: name,
    stage: "post-turn",
    outputKind,
  };
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
    status: "success" as "success" | "skipped",
    output,
    effects,
    toolCalls: [] as const,
    durationMs: 1,
    timestamp: new Date().toISOString(),
    pendingProposals: undefined as readonly Proposal[] | undefined,
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
      takenUnder: { playerTurns: 0, pluginVersion: "1.0.0", writes: [] },
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

/** A plugin.data write that commits. */
function pluginData(field: string, value: JsonValue): RuntimeEffects {
  return { pluginData: [{ namespace: "stats", key: field, value }] };
}

/** A malformed notification rejects the runtime write. */
function malformedEffects(): RuntimeEffects {
  return { notifications: [null] };
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
          makeResult("tracker", {}, pluginData("hp", 99)),
        ],
        turnIds: [TURN_ID],
        extraInTx: async () => {
          controller.abort();
        },
      });
      expect(outcome.status).toBe("failed");
      expect(outcome.events).toEqual([]);
      expect(
        await store.getPluginData(SESSION_ID, "tracker", "stats", "hp"),
      ).toBeNull();
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
      results: [makeResult("rt-a", {}, malformedEffects())],
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

    // Runtime A commits several explicit effects; runtime B's malformed notification
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
            events: [{ topic: "stats.changed", data: { hp: 42 } }],
            pluginData: [
              { namespace: "stats", key: "hp", value: 42 },
              { namespace: "entries", key: "rollback", value: { hp: 42 } },
            ],
          },
        ),
        makeResult("rt-b", {}, malformedEffects()),
      ],
      turnIds: [TURN_ID],
      emitter,
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.events).toHaveLength(0);
    expect(outcome.failedProposals).toHaveLength(1);
    expect(outcome.failedProposals[0]!.error).toMatch(
      /effects\.notifications\[0\] is not an object/,
    );

    // The committed sibling's write is rolled back — DB has no trace of it.
    expect(
      await store.getPluginData(SESSION_ID, "rt-a", "stats", "hp"),
    ).toBeNull();
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
      results: [makeResult("rt-a", {}, pluginData("hp", 10))],
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
      results: [makeResult("rt-a", {}, malformedEffects())],
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
        makeResult(
          "rt-a",
          {},
          {
            ...pluginData("hp", 10),
            interactions: [{ interactionId: "hp", type: "form" }],
          },
        ),
        makeResult(
          "rt-b",
          {},
          {
            ...pluginData("mp", 20),
            interactions: [{ interactionId: "mp", type: "form" }],
          },
        ),
      ],
      turnIds: [TURN_ID],
      emitter,
    });

    expect(outcome.status).toBe("committed");
    expect(outcome.failedProposals).toHaveLength(0);
    expect(outcome.events.map((e) => e.type)).toEqual([
      "interaction.requested",
      "interaction.requested",
    ]);

    // Both writes landed.
    expect(
      (await store.getPluginData(SESSION_ID, "rt-a", "stats", "hp"))?.value,
    ).toBe(10);
    expect(
      (await store.getPluginData(SESSION_ID, "rt-b", "stats", "mp"))?.value,
    ).toBe(20);
    expect(await commitStatusOf(store)).toBe("committed");

    // Deferred fan-out flushed after commit, in proposal (runtime) order.
    expect(emits.map((e) => e.type)).toEqual([
      "block.emitted",
      "block.emitted",
    ]);
    expect(
      emits.map(
        (e) =>
          (e.payload.block as { data: { interactionId: string } }).data
            .interactionId,
      ),
    ).toEqual(["hp", "mp"]);
  });

  it("resets subscribers and traces it when the committed events cannot be published", async () => {
    const store = createMemoryStore();
    await savePendingTurn(store);
    const eventBus = createEventBus();
    const resets: Array<{ sessionId?: string; reason: string }> = [];
    eventBus.onReset?.((reset) => resets.push(reset));
    const { emitter, emits } = makeRecordingEmitter();
    const emit = emitter.emit.bind(emitter);
    (emitter as { emit: TurnEmitter["emit"] }).emit = async (type, payload) => {
      if (type === "block.emitted") throw new Error("subscriber gone");
      await emit(type, payload);
    };
    const logged = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const outcome = await finalizeExecution({
        executionContext: {
          executionId: crypto.randomUUID(),
          origin: "manual",
          countPolicy: "none",
        },
        store,
        sessionId: SESSION_ID,
        runtimes: [makeRuntime("rt-a")],
        results: [
          makeResult(
            "rt-a",
            {},
            {
              ...pluginData("hp", 10),
              interactions: [{ interactionId: "hp", type: "form" }],
            },
          ),
        ],
        turnIds: [TURN_ID],
        emitter,
        eventBus,
      });

      // The data is stored; only the way to hear about it failed.
      expect(outcome.status).toBe("committed");
      expect(outcome.fanOutFailed).toBe(true);
      expect(
        (await store.getPluginData(SESSION_ID, "rt-a", "stats", "hp"))?.value,
      ).toBe(10);
      expect(resets).toEqual([
        { sessionId: SESSION_ID, reason: "publish-failed" },
      ]);
      expect(emits).toEqual([
        {
          type: "commit.fanout.failed",
          payload: expect.objectContaining({
            failedCount: 1,
            errors: ["subscriber gone"],
          }),
        },
      ]);
    } finally {
      logged.mockRestore();
      await eventBus.close();
    }
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
        makeResult("rt-b", {}, pluginData("hp", 99)),
        makeResult("rt-a", { toolCalls: [] }),
      ],
      turnIds: [TURN_ID],
    });
    expect(outcome.status).toBe("failed");
    expect(
      await store.getPluginData(SESSION_ID, "rt-b", "stats", "hp"),
    ).toBeNull();
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
        makeResult("rt-b", {}, malformedEffects()),
      ],
      turnIds: [TURN_ID],
    });

    expect(outcome).toMatchObject({
      status: "committed",
      isolatedRuntimes: [
        { runtimeId: "rt-b", cause: "rejected", error: expect.any(String) },
      ],
    });
    expect(outcome.failedProposals).toHaveLength(1);
    expect(await store.listMessages(SESSION_ID)).toHaveLength(1);
    expect(await commitStatusOf(store)).toBe("committed");
  });

  it.each([
    {
      statePatches: [{ table: "stats", field: "hp", value: 1 }],
      pluginData: [{ namespace: "stats", key: "hp", value: 2 }],
    },
    { statePatches: [] },
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
      if ("statePatches" in effects) {
        expect(result.failedProposals[0]?.proposal).toMatchObject({
          type: "effects.invalid",
          source: { pluginId: "sibling", runtimeId: "sibling" },
          payload: {
            error:
              "effects.statePatches is no longer supported; use plugin data (effects.pluginData) instead",
          },
        });
        expect(result.failedProposals[0]?.error).toBe(
          "effects.statePatches is no longer supported; use plugin data (effects.pluginData) instead",
        );
        expect(
          await store.getPluginData(SESSION_ID, "sibling", "stats", "hp"),
        ).toBeNull();
      }
      expect(
        (await store.listMessages(SESSION_ID)).map(
          (message) => message.content,
        ),
      ).toEqual(["The door opens."]);
      expect(await commitStatusOf(store)).toBe("committed");
    },
  );

  it.each([
    {
      block: { parts: [null] },
      error: "effects.ui[0].parts[0] is not an object",
    },
    {
      block: { type: "card", text: "legacy" },
      error: "effects.ui[0].parts is not an array",
    },
  ])(
    "keeps a committed story when a sibling returned malformed UI ($error)",
    async ({ block, error }) => {
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
          makeResult("rt-b", {}, { ui: [block] } as never),
        ],
        turnIds: [TURN_ID],
      });

      expect(outcome).toMatchObject({
        status: "committed",
        isolatedRuntimes: [
          {
            runtimeId: "rt-b",
            error,
          },
        ],
      });
      expect(await store.listMessages(SESSION_ID)).toHaveLength(1);
      expect(await commitStatusOf(store)).toBe("committed");
    },
  );

  it("keeps a dropped sibling's journal rows and trigger count out", async () => {
    const store = createMemoryStore();
    const now = new Date().toISOString();
    // The trigger ledger records against the session row.
    await store.createSession({
      locale: "en-US",
      id: SESSION_ID,
      phase: "playing",
      status: "active",
      completedPlayerTurns: 0,
      setupRuntimes: {},
      seats: [
        { id: "main", controller: "human", role: "player", characters: "auto" },
      ],
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
        makeResult("rt-b", {}, malformedEffects()),
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
        makeResult("rt-b", {}, malformedEffects()),
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
        makeResult("rt-b", {}, malformedEffects()),
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
        results: [makeResult("rt-a", {}, pluginData("hp", 3))],
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
        results: [makeResult("rt-a", {}, malformedEffects())],
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
          makeResult("up", {}, malformedEffects()),
          {
            ...makeResult("down"),
            status,
            pendingProposals: [
              {
                id: "guard-write",
                type: "plugin.data" as const,
                sessionId: SESSION_ID,
                turnId: TURN_ID,
                source: { pluginId: "down", runtimeId: "down" },
                timestamp: new Date().toISOString(),
                payload: { namespace: "stats", key: "derived", value: 2 },
              },
            ],
          },
          makeResult("late", {}, pluginData("late", 3)),
        ],
      );

      expect(outcome).toMatchObject({
        status: "committed",
        isolatedRuntimes: [
          { runtimeId: "up", cause: "rejected", error: expect.any(String) },
          {
            runtimeId: "down",
            cause: "upstream",
            error: "upstream up did not commit",
          },
        ],
      });
      expect(
        await store.getPluginData(SESSION_ID, "down", "stats", "derived"),
      ).toBe(null);
      expect(
        (await store.getPluginData(SESSION_ID, "late", "stats", "late"))?.value,
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
            ...malformedEffects(),
            events: [{ topic: "found", data: {} }],
          },
        ),
        makeResult("reader", {}, pluginData("reader", 1)),
        makeResult("optional-reader", {}, pluginData("optional", 1)),
        makeResult("follower", {}, pluginData("follower", 1)),
      ],
    );

    expect(outcome.isolatedRuntimes?.map((item) => item.runtimeId)).toEqual([
      "up",
      "reader",
      "follower",
    ]);
    expect(
      (
        await store.getPluginData(
          SESSION_ID,
          "optional-reader",
          "stats",
          "optional",
        )
      )?.value,
    ).toBe(1);
    expect(
      await store.getPluginData(SESSION_ID, "follower", "stats", "follower"),
    ).toBe(null);
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
          makeResult("provider-a", {}, malformedEffects()),
          makeResult("provider-b", {}, pluginData("b", 1)),
          makeResult("consumer", {}, pluginData("consumer", 1)),
        ],
      );

      const consumer = await store.getPluginData(
        SESSION_ID,
        "consumer",
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
        makeResult("context", {}, malformedEffects()),
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
        makeResult("up", {}, malformedEffects()),
        makeResult("down", {}, pluginData("derived", 2)),
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

describe("finalizeExecution — plugin.data.update", () => {
  const manual = () => ({
    executionId: crypto.randomUUID(),
    origin: "manual" as const,
    countPolicy: "none" as const,
  });
  const update = (
    runtimeId: string,
    ops: readonly import("@covel/shared").DataOp[],
  ): Proposal => ({
    id: crypto.randomUUID(),
    type: "plugin.data.update",
    source: { pluginId: runtimeId, runtimeId },
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    payload: { namespace: "wallet", key: "gold", ops },
    timestamp: new Date().toISOString(),
  });
  const withProposals = (
    result: ReturnType<typeof makeResult>,
    proposals: readonly Proposal[],
  ) => ({ ...result, pendingProposals: proposals });
  const seedGold = async (store: DataStore, pluginId: string, value: number) =>
    store.setPluginData({
      id: crypto.randomUUID(),
      sessionId: SESSION_ID,
      pluginId,
      namespace: "wallet",
      key: "gold",
      value,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  const gold = async (store: DataStore, pluginId: string) =>
    (await store.getPluginData(SESSION_ID, pluginId, "wallet", "gold"))?.value;

  it("drops an auxiliary runtime whose op list is rejected and keeps the story and siblings", async () => {
    const store = createMemoryStore();
    await savePendingTurn(store);
    await seedGold(store, "aux", 1);
    const outcome = await finalizeExecution({
      executionContext: manual(),
      store,
      sessionId: SESSION_ID,
      runtimes: [
        makeRuntime("story", "story"),
        makeRuntime("aux"),
        makeRuntime("sibling"),
      ],
      results: [
        makeResult("story", { narrativeOutput: "The till rings." }),
        withProposals(makeResult("aux"), [
          update("aux", [{ op: "inc", by: -2, min: 0 }]),
        ]),
        withProposals(makeResult("sibling"), [
          update("sibling", [{ op: "inc", by: 3 }]),
        ]),
      ],
      turnIds: [TURN_ID],
    });
    expect(outcome).toMatchObject({
      status: "committed",
      isolatedRuntimes: [{ runtimeId: "aux", error: expect.any(String) }],
    });
    expect(outcome.failedProposals).toEqual([
      expect.objectContaining({ code: "data-op-rejected" }),
    ]);
    expect(await gold(store, "aux")).toBe(1);
    expect(await gold(store, "sibling")).toBe(3);
    expect(await store.listMessages(SESSION_ID)).toHaveLength(1);
  });

  it("rolls the whole execution back on the same failure without a story", async () => {
    const store = createMemoryStore();
    await savePendingTurn(store);
    await seedGold(store, "aux", 1);
    const outcome = await finalizeExecution({
      executionContext: manual(),
      store,
      sessionId: SESSION_ID,
      runtimes: [makeRuntime("aux"), makeRuntime("sibling")],
      results: [
        withProposals(makeResult("sibling"), [
          update("sibling", [{ op: "inc", by: 3 }]),
        ]),
        withProposals(makeResult("aux"), [
          update("aux", [{ op: "inc", by: -2, min: 0 }]),
        ]),
      ],
      turnIds: [TURN_ID],
    });
    expect(outcome.status).toBe("failed");
    expect(await gold(store, "aux")).toBe(1);
    expect(await gold(store, "sibling")).toBeUndefined();
    expect(await commitStatusOf(store)).toBe("failed");
  });

  it.each([
    {
      label: "does not compile",
      schema: { type: "invalid" },
      ops: [{ op: "inc", by: 1 }] as const,
    },
    {
      // An async validator returns a Promise, which must not read as success.
      label: "is asynchronous",
      schema: { $async: true, type: "number" },
      ops: [{ op: "set", value: "rich" }] as const,
    },
  ])(
    "drops an auxiliary runtime whose dataset schema $label and keeps the story",
    async ({ schema, ops }) => {
      const store = createMemoryStore();
      await savePendingTurn(store);
      await seedGold(store, "aux", 1);
      const outcome = await finalizeExecution({
        executionContext: manual(),
        store,
        sessionId: SESSION_ID,
        runtimes: [
          makeRuntime("story", "story"),
          {
            ...makeRuntime("aux"),
            datasets: {
              wallet: {
                namespace: "wallet",
                ops: ["inc", "set"],
                schema: "schemas/wallet.json",
              },
            },
          },
        ],
        datasetSchemas: { aux: { wallet: schema } },
        results: [
          makeResult("story", { narrativeOutput: "The till rings." }),
          withProposals(makeResult("aux"), [update("aux", ops)]),
        ],
        turnIds: [TURN_ID],
      });
      expect(outcome).toMatchObject({
        status: "committed",
        isolatedRuntimes: [{ runtimeId: "aux", error: expect.any(String) }],
      });
      expect(outcome.failedProposals).toEqual([
        expect.objectContaining({ code: "dataset-violation" }),
      ]);
      expect(await gold(store, "aux")).toBe(1);
      expect(await store.listMessages(SESSION_ID)).toHaveLength(1);
      expect(await commitStatusOf(store)).toBe("committed");
    },
  );

  describe("through executeTurn and commitExecution", () => {
    const wallet = (extra: Partial<RuntimeManifest> = {}): RuntimeManifest => ({
      name: "bank/main",
      pluginId: "bank",
      description: "bank",
      runtimeType: "function",
      stage: "narrative",
      trigger: { type: "auto" },
      ...extra,
    });
    const session = async () => {
      const store = createMemoryStore();
      await store.createSession({
        id: SESSION_ID,
        locale: "en-US",
        status: "active",
        phase: "playing",
        setupRuntimes: {},
        seats: [
          {
            id: "main",
            controller: "human",
            role: "player",
            characters: "auto",
          },
        ],
        activePlugins: ["bank"],
        completedPlayerTurns: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      return store;
    };
    const turn = (turnId: string) => ({
      sessionId: SESSION_ID,
      turnId,
      logicalTurnId: `logical-${turnId}`,
      playerMessage: "Deposit",
      origin: "manual" as const,
    });
    const commit = (
      store: DataStore,
      execution: Awaited<ReturnType<typeof executeTurn>>,
    ) =>
      commitExecution({
        store,
        execution,
        completion: {
          kind: "turn",
          turnId: execution.result.turnId,
          durationMs: 1,
        },
      });

    it("keeps both of two inc +1 prepared before either commits (no lost update)", async () => {
      const store = await session();
      await seedGold(store, "bank", 10);
      const runtime = wallet();
      const loadRuntime = async (
        manifest: RuntimeManifest,
      ): Promise<LoadedRuntime> => ({
        manifest,
        promptTemplate: "",
        handler: async (ctx) => {
          await ctx.pluginData!.update("wallet", "gold", [
            { op: "inc", by: 1 },
          ]);
          expect(await ctx.pluginData!.get("wallet", "gold")).toBe(11);
          return { outcome: "success" as const, value: {} };
        },
      });
      const deps = { store, loadRuntime, llm: { generate: vi.fn() } };
      const first = await executeTurn(turn("t1"), [runtime], deps);
      const second = await executeTurn(turn("t2"), [runtime], deps);
      expect(await gold(store, "bank")).toBe(10);
      expect((await commit(store, first)).status).toBe("committed");
      expect((await commit(store, second)).status).toBe("committed");
      expect(await gold(store, "bank")).toBe(12);
    });

    it("carries the captured dataset schemas to the commit handler", async () => {
      const store = await session();
      const schema = {
        type: "object",
        properties: { amount: { type: "integer", minimum: 0 } },
        required: ["amount"],
      };
      const runtime = wallet({
        datasets: {
          wallet: {
            namespace: "wallet",
            schema: "./wallet.json",
            ops: ["set", "inc"],
          },
        },
      });
      const datasetSchemas = { wallet: schema };
      let ops: readonly import("@covel/shared").DataOp[] = [];
      const loadRuntime = async (
        manifest: RuntimeManifest,
      ): Promise<LoadedRuntime> => ({
        manifest,
        promptTemplate: "",
        datasetSchemas,
        handler: async (ctx) => {
          await ctx.pluginData!.update("wallet", "gold", ops);
          return { outcome: "success" as const, value: {} };
        },
      });
      const deps = { store, loadRuntime, llm: { generate: vi.fn() } };

      ops = [{ op: "set", value: { amount: 5 } }];
      const valid = await executeTurn(turn("t1"), [runtime], deps);
      expect(valid.commit.datasetSchemas?.bank?.wallet).toBe(schema);
      expect((await commit(store, valid)).status).toBe("committed");
      expect(await gold(store, "bank")).toEqual({ amount: 5 });

      ops = [{ op: "set", value: { amount: -1 } }];
      const invalid = await commit(
        store,
        await executeTurn(turn("t2"), [runtime], deps),
      );
      expect(invalid.status).toBe("failed");
      expect(invalid.failedProposals).toEqual([
        expect.objectContaining({ code: "dataset-violation" }),
      ]);

      ops = [{ op: "merge", value: { amount: 1 } }];
      const refused = await commit(
        store,
        await executeTurn(turn("t3"), [runtime], deps),
      );
      expect(refused.failedProposals[0]?.error).toMatch(
        /operation kind merge is not allowed/,
      );
      expect(await gold(store, "bank")).toEqual({ amount: 5 });
    });
  });
});
