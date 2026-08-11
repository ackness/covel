/**
 * Whole-execution finalize primitive tests.
 *
 * `finalizeExecution` is the shared commit boundary for a completed execution's
 * runtime results. Unlike the old per-runtime `commitAll`, it wraps the FULL
 * set of results in one `store.withTransaction`, so any proposal failure rolls
 * the whole turn back — a committed sibling included (the deliberate change).
 * These tests pin that boundary on the real MemoryStore (which rolls back via
 * snapshot restore) plus the degraded path for stores without transactions.
 */

import { describe, it, expect } from "vitest";
import { createMemoryStore, type DataStore } from "@covel/store";
import type { TurnEmitter } from "../src/trace/turn-emitter.js";
import { finalizeExecution } from "../src/commit/finalize-execution.js";

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
  return { name, pluginId: name, outputKind, capabilities: [] };
}

function makeResult(runtimeId: string, output: ResultOutput) {
  return {
    pluginId: runtimeId,
    runtimeId,
    runId: crypto.randomUUID(),
    turnId: TURN_ID,
    status: "success" as const,
    output,
    toolCalls: [] as const,
    durationMs: 1,
    timestamp: new Date().toISOString(),
  };
}

/** A state.patch that commits; assert via `getStateEntry`. */
function statePatch(field: string, value: unknown): ResultOutput {
  return { statePatches: [{ table: "stats", field, value }] };
}

/** A state.patch missing `table` — the handler rejects it with `{ committed: false }`. */
function badStatePatch(): ResultOutput {
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

/** Strip `withTransaction` so finalize takes the degraded (no-rollback) path. */
function withoutTransaction(store: DataStore): DataStore {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "withTransaction") return undefined;
      return Reflect.get(target, prop, receiver);
    },
  }) as DataStore;
}

describe("finalizeExecution", () => {
  it("rolls the whole execution back when a later runtime's proposal fails", async () => {
    const store = createMemoryStore();
    await savePendingTurn(store);
    const { emitter, emits } = makeRecordingEmitter();

    // Runtime A commits a state.patch (fan-out buffered); runtime B's patch is
    // malformed and the handler rejects it with { committed: false }.
    const outcome = await finalizeExecution({
      store,
      sessionId: SESSION_ID,
      runtimes: [makeRuntime("rt-a"), makeRuntime("rt-b")],
      results: [
        makeResult("rt-a", statePatch("hp", 42)),
        makeResult("rt-b", badStatePatch()),
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
    // The execution's turn_results row is settled failed.
    expect(await commitStatusOf(store)).toBe("failed");
    // No post-commit fan-out leaked for the rolled-back sibling.
    expect(emits).toHaveLength(0);
  });

  it("commits execution journal messages with successful proposals", async () => {
    const store = createMemoryStore();
    await savePendingTurn(store);

    const outcome = await finalizeExecution({
      store,
      sessionId: SESSION_ID,
      runtimes: [makeRuntime("rt-a")],
      results: [makeResult("rt-a", statePatch("hp", 10))],
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
      store,
      sessionId: SESSION_ID,
      runtimes: [makeRuntime("rt-a")],
      results: [makeResult("rt-a", badStatePatch())],
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
      store,
      sessionId: SESSION_ID,
      runtimes: [makeRuntime("rt-a"), makeRuntime("rt-b")],
      results: [
        makeResult("rt-a", statePatch("hp", 10)),
        makeResult("rt-b", statePatch("mp", 20)),
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

  it("rolls back on a handler validation failure even without a thrown store error", async () => {
    const store = createMemoryStore();
    await savePendingTurn(store);

    // Runtime A commits a narrative message; runtime B is rejected by the
    // validator (no throw). The rollback must still undo A's message.
    const outcome = await finalizeExecution({
      store,
      sessionId: SESSION_ID,
      runtimes: [makeRuntime("rt-a", "story"), makeRuntime("rt-b")],
      results: [
        makeResult("rt-a", { narrativeOutput: "committed line" }),
        makeResult("rt-b", badStatePatch()),
      ],
      turnIds: [TURN_ID],
    });

    expect(outcome.status).toBe("failed");
    expect(await store.listMessages(SESSION_ID)).toHaveLength(0);
    expect(await commitStatusOf(store)).toBe("failed");
  });

  it("rolls back the whole execution when extraInTx throws", async () => {
    const store = createMemoryStore();
    await savePendingTurn(store);

    const outcome = await finalizeExecution({
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

  it("degrades to one-at-a-time commits (no cross-runtime rollback) without withTransaction", async () => {
    const store = createMemoryStore();
    await savePendingTurn(store);
    const degraded = withoutTransaction(store);

    const outcome = await finalizeExecution({
      store: degraded,
      sessionId: SESSION_ID,
      runtimes: [makeRuntime("rt-a", "story"), makeRuntime("rt-b")],
      results: [
        makeResult("rt-a", { narrativeOutput: "committed line" }),
        makeResult("rt-b", badStatePatch()),
      ],
      turnIds: [TURN_ID],
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.failedProposals).toHaveLength(1);
    // Degraded mode cannot roll back — runtime A's write survives the failure.
    expect(await store.listMessages(SESSION_ID)).toHaveLength(1);
    expect(await commitStatusOf(store)).toBe("failed");
  });

  it("commits cleanly on the degraded path when every proposal succeeds", async () => {
    const store = createMemoryStore();
    await savePendingTurn(store);
    const degraded = withoutTransaction(store);

    const outcome = await finalizeExecution({
      store: degraded,
      sessionId: SESSION_ID,
      runtimes: [makeRuntime("rt-a")],
      results: [makeResult("rt-a", statePatch("hp", 7))],
      turnIds: [TURN_ID],
    });

    expect(outcome.status).toBe("committed");
    expect((await store.getStateEntry(SESSION_ID, "stats", "hp"))?.value).toBe(
      7,
    );
    expect(await commitStatusOf(store)).toBe("committed");
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
        results: [makeResult("rt-a", statePatch("hp", 3))],
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
        results: [makeResult("rt-a", badStatePatch())],
        turnIds: [TURN_ID],
      });

      expect(outcome.status).toBe("failed");
      // Job-status is append-only and outside the domain transaction: the
      // rollback erases domain writes but the terminal failed marker lands.
      expect(await latestJobState(store)).toBe("failed");
    });
  });
});
