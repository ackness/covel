/**
 * Session kernel commit-atomicity tests.
 *
 * Verifies that `commitAll()` wraps the proposal chain in a single scoped
 * `withTransaction` callback by default (writes flow through the tx-bound store
 * view), and falls back to the legacy non-transactional loop when the store
 * does not expose `withTransaction`. The begin/commit/rollback counters track
 * the transaction lifecycle: entry → begin, clean return → commit, thrown
 * error → rollback (auto-restore).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Proposal } from "@covel/shared";
import {
  createCommitPipeline,
  type KernelStore,
} from "../src/session/session-kernel.js";

const SOURCE = { pluginId: "txn-test", runtimeId: "txn-test" };
const TURN_ID = "turn-txn";
const SESSION_ID = "sess-txn";

interface RecordingStore extends KernelStore {
  readonly messages: Array<Record<string, unknown>>;
  readonly stateChanges: Array<Record<string, unknown>>;
  readonly events: Array<Record<string, unknown>>;
  readonly traceEvents: Array<Record<string, unknown>>;
  readonly beginCalls: { count: number };
  readonly commitCalls: { count: number };
  readonly rollbackCalls: { count: number };
  failOn?: {
    method: "addMessage" | "addStateChange" | "saveEvent";
    afterN: number;
  };
}

function createRecordingStore(): RecordingStore {
  const messages: Array<Record<string, unknown>> = [];
  const stateChanges: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  const traceEvents: Array<Record<string, unknown>> = [];
  const beginCalls = { count: 0 };
  const commitCalls = { count: 0 };
  const rollbackCalls = { count: 0 };

  const counters: Record<string, number> = {
    addMessage: 0,
    addStateChange: 0,
    saveEvent: 0,
  };

  let snapshot: {
    messages: Array<Record<string, unknown>>;
    stateChanges: Array<Record<string, unknown>>;
    events: Array<Record<string, unknown>>;
  } | null = null;

  function maybeFail(
    method: "addMessage" | "addStateChange" | "saveEvent",
  ): void {
    counters[method]++;
    if (
      store.failOn &&
      store.failOn.method === method &&
      counters[method] === store.failOn.afterN
    ) {
      throw new Error(`forced failure on ${method}#${counters[method]}`);
    }
  }

  const store: RecordingStore = {
    messages,
    stateChanges,
    events,
    traceEvents,
    beginCalls,
    commitCalls,
    rollbackCalls,

    async addMessage(record) {
      maybeFail("addMessage");
      messages.push(record as Record<string, unknown>);
    },
    async updateSession(id, patch) {
      // not exercised
      void id;
      void patch;
    },
    async saveEvent(record) {
      maybeFail("saveEvent");
      events.push(record as Record<string, unknown>);
    },
    async addStateChange(record) {
      maybeFail("addStateChange");
      stateChanges.push(record as Record<string, unknown>);
    },
    async upsertStateEntry(record) {
      // state.patch commits the current value here before addStateChange; these
      // tests only assert the change log / message / event arrays, so no-op.
      void record;
    },
    async addTraceEvent(record) {
      traceEvents.push(record as Record<string, unknown>);
    },
    // Scoped transaction: snapshot on entry, restore on throw. The tx-bound
    // store view is the store itself (writes land in the shared arrays), which
    // mirrors how single-connection backends fold writes into the open
    // transaction. A clean return commits (snapshot discarded); a thrown error
    // rolls back (arrays restored) and re-throws to the caller.
    async withTransaction(fn) {
      beginCalls.count++;
      snapshot = {
        messages: [...messages],
        stateChanges: [...stateChanges],
        events: [...events],
      };
      try {
        const result = await fn(store);
        commitCalls.count++;
        snapshot = null;
        return result;
      } catch (err) {
        rollbackCalls.count++;
        if (snapshot) {
          messages.length = 0;
          messages.push(...snapshot.messages);
          stateChanges.length = 0;
          stateChanges.push(...snapshot.stateChanges);
          events.length = 0;
          events.push(...snapshot.events);
          snapshot = null;
        }
        throw err;
      }
    },
  };

  return store;
}

function makeProposal(
  type: Proposal["type"],
  payload: Record<string, unknown>,
  idSuffix: string,
): Proposal {
  return {
    id: `prop-${idSuffix}`,
    type,
    source: SOURCE,
    turnId: TURN_ID,
    sessionId: SESSION_ID,
    payload,
    timestamp: new Date().toISOString(),
  };
}

describe("session-kernel commitAll atomicity", () => {
  it("rolls back earlier writes when a later commit throws", async () => {
    const store = createRecordingStore();
    store.failOn = { method: "addStateChange", afterN: 1 };

    const pipeline = createCommitPipeline(store);
    const proposals: Proposal[] = [
      makeProposal(
        "narrative.append",
        { content: "step 1", kind: "story" },
        "a",
      ),
      makeProposal(
        "state.patch",
        { table: "stats", field: "hp", value: 50 },
        "b",
      ),
      makeProposal(
        "narrative.append",
        { content: "step 3", kind: "story" },
        "c",
      ),
    ];

    await expect(pipeline.commitAll(proposals)).rejects.toThrow(
      /forced failure/,
    );

    // All writes rolled back.
    expect(store.messages).toHaveLength(0);
    expect(store.stateChanges).toHaveLength(0);

    expect(store.beginCalls.count).toBe(1);
    expect(store.commitCalls.count).toBe(0);
    expect(store.rollbackCalls.count).toBe(1);
  });

  it("commits all writes when the proposal chain succeeds", async () => {
    const store = createRecordingStore();
    const pipeline = createCommitPipeline(store);

    const proposals: Proposal[] = [
      makeProposal("narrative.append", { content: "ok 1", kind: "story" }, "a"),
      makeProposal(
        "state.patch",
        { table: "stats", field: "hp", value: 80 },
        "b",
      ),
      makeProposal("event.emit", { topic: "test", data: { x: 1 } }, "c"),
    ];

    const results = await pipeline.commitAll(proposals);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.committed)).toBe(true);

    expect(store.messages).toHaveLength(1);
    expect(store.stateChanges).toHaveLength(1);
    expect(store.events).toHaveLength(1);

    expect(store.beginCalls.count).toBe(1);
    expect(store.commitCalls.count).toBe(1);
    expect(store.rollbackCalls.count).toBe(0);
  });

  it("validation failure does NOT roll back committed siblings (best-effort) and warns", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store = createRecordingStore();
      const pipeline = createCommitPipeline(store);

      const proposals: Proposal[] = [
        makeProposal("narrative.append", { content: "ok", kind: "story" }, "a"),
        // Malformed: .js plugins bypass the type layer, so table can be missing.
        makeProposal("state.patch", { field: "hp", value: 1 }, "b"),
        makeProposal("event.emit", { topic: "test", data: {} }, "c"),
      ];

      const results = await pipeline.commitAll(proposals);
      expect(results[0].committed).toBe(true);
      expect(results[1].committed).toBe(false);
      expect(results[1].error).toMatch(/table must be a non-empty string/);
      expect(results[2].committed).toBe(true);

      // Siblings stay committed; the transaction commits (no rollback).
      expect(store.messages).toHaveLength(1);
      expect(store.stateChanges).toHaveLength(0);
      expect(store.events).toHaveLength(1);
      expect(store.commitCalls.count).toBe(1);
      expect(store.rollbackCalls.count).toBe(0);

      // The partial commit is surfaced loudly, not silently swallowed.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("partial commit detected"),
        "transactional mode",
        2,
        1,
        expect.stringContaining("prop-b"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("rejects state.patch/event.emit with empty identifiers instead of defaulting", async () => {
    const store = createRecordingStore();
    const pipeline = createCommitPipeline(store);

    const results = await pipeline.commitAll([
      makeProposal("state.patch", { table: "", field: "hp", value: 1 }, "a"),
      makeProposal("event.emit", { data: { x: 1 } }, "b"),
    ]);

    expect(results[0].committed).toBe(false);
    expect(results[0].error).toMatch(/table must be a non-empty string/);
    expect(results[1].committed).toBe(false);
    expect(results[1].error).toMatch(/topic must be a non-empty string/);
    expect(store.stateChanges).toHaveLength(0);
    expect(store.events).toHaveLength(0);
  });

  it("buffers emitter fan-out until COMMIT: a later throwing proposal leaves no ghost events (R-08)", async () => {
    const store = createRecordingStore();
    // Proposal 1 (interaction.request) commits fine; proposal 2 throws a
    // store error → whole tx rolls back.
    store.failOn = { method: "addStateChange", afterN: 1 };

    const emitted: Array<{ type: string; commitCount: number }> = [];
    const emitter = {
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      traceId: "trace-r08",
      async emit(type: string) {
        emitted.push({ type, commitCount: store.commitCalls.count });
      },
    };

    const pipeline = createCommitPipeline(
      store,
      undefined,
      undefined,
      emitter as never,
    );
    await expect(
      pipeline.commitAll([
        makeProposal(
          "interaction.request",
          { interactionId: "i1", type: "confirmation", prompt: "ok?" },
          "a",
        ),
        makeProposal(
          "state.patch",
          { table: "stats", field: "hp", value: 1 },
          "b",
        ),
      ]),
    ).rejects.toThrow(/forced failure/);

    // Rolled back — and the client never saw block.emitted for proposal a.
    expect(store.rollbackCalls.count).toBe(1);
    expect(emitted).toHaveLength(0);
  });

  it("flushes emitter fan-out strictly after COMMIT on success (R-08)", async () => {
    const store = createRecordingStore();
    const emitted: Array<{ type: string; commitCount: number }> = [];
    const emitter = {
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      traceId: "trace-r08",
      async emit(type: string) {
        emitted.push({ type, commitCount: store.commitCalls.count });
      },
    };

    const pipeline = createCommitPipeline(
      store,
      undefined,
      undefined,
      emitter as never,
    );
    const results = await pipeline.commitAll([
      makeProposal(
        "interaction.request",
        { interactionId: "i1", type: "confirmation", prompt: "ok?" },
        "a",
      ),
    ]);

    expect(results[0].committed).toBe(true);
    expect(emitted.map((e) => e.type)).toContain("block.emitted");
    // Every fan-out event was observed AFTER the transaction committed.
    expect(emitted.every((e) => e.commitCount === 1)).toBe(true);
  });

  it("stamps proposal.committed trace rows with the emitter's traceId, not turnId (R-14)", async () => {
    const store = createRecordingStore();
    const emitter = {
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      traceId: "sse-trace-id",
      async emit() {},
    };

    const pipeline = createCommitPipeline(
      store,
      undefined,
      undefined,
      emitter as never,
    );
    await pipeline.commitAll([
      makeProposal("narrative.append", { content: "hi", kind: "story" }, "a"),
    ]);

    const committedRows = store.traceEvents.filter(
      (t) => t.type === "proposal.committed",
    );
    expect(committedRows).toHaveLength(1);
    expect(committedRows[0].traceId).toBe("sse-trace-id");
    expect(committedRows[0].turnId).toBe(TURN_ID);
  });

  it("store missing tx hooks: falls back to non-transactional path", async () => {
    const store: KernelStore = {
      addMessage: vi.fn().mockResolvedValue(undefined),
      updateSession: vi.fn().mockResolvedValue(undefined),
      saveEvent: vi.fn().mockResolvedValue(undefined),
      addStateChange: vi.fn().mockResolvedValue(undefined),
      upsertStateEntry: vi.fn().mockResolvedValue(undefined),
      addTraceEvent: vi.fn().mockResolvedValue(undefined),
    };

    const pipeline = createCommitPipeline(store);
    const proposals: Proposal[] = [
      makeProposal(
        "narrative.append",
        { content: "legacy", kind: "story" },
        "a",
      ),
    ];

    const results = await pipeline.commitAll(proposals);
    expect(results).toHaveLength(1);
    expect(results[0].committed).toBe(true);
    expect(store.addMessage).toHaveBeenCalledOnce();
  });
});
