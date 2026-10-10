import { describe, expect, it } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import type { DataStore } from "@covel/store";
import { loadTurnSessionState } from "../src/turn-executor/session-state.js";
import { recordRuntimeTriggersTx } from "../src/trigger/trigger-ledger.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor-types.js";

/**
 * Audit 2026-07-11 R-13 + 2026-07-17 bounded-history follow-up:
 * loadTurnSessionState used to full-read listTurnMessages twice per turn.
 * Today the per-turn reads are (a) one listUncompactedTurnMessages for the
 * raw suffix, (b) one getTurnMessageStats aggregate for turnNumber — never a
 * full listTurnMessages. Trigger history comes from the trigger ledger. The current player record stays in
 * the execution journal until commit; these tests pin both the read pattern
 * and that committed history remains isolated from pending input.
 */

async function makeStore(): Promise<DataStore> {
  const store = createMemoryStore();
  const now = new Date().toISOString();
  await store.createSession({
    id: "sess-dedup",
    worldId: "w1",
    status: "active",
    phase: "playing",
    completedPlayerTurns: 1,
    setupRuntimes: {},
    locale: "zh-CN",
    activePlugins: [],
    createdAt: now,
    updatedAt: now,
  });
  await store.appendTurnMessage({
    id: "tm-0",
    sessionId: "sess-dedup",
    turnId: "turn-0",
    sourceType: "player",
    role: "user",
    content: "earlier turn",
    order: 0,
    createdAt: now,
  });
  return store;
}

function countingStore(store: DataStore): {
  store: DataStore;
  counts: () => Record<string, number>;
} {
  const calls: Record<string, number> = {};
  const counted = new Set([
    "listTurnMessages",
    "listUncompactedTurnMessages",
    "getTurnMessageStats",
  ]);
  const wrapped = new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (
        typeof prop === "string" &&
        counted.has(prop) &&
        typeof value === "function"
      ) {
        return (...args: unknown[]) => {
          calls[prop] = (calls[prop] ?? 0) + 1;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { store: wrapped, counts: () => calls };
}

describe("loadTurnSessionState read dedup (audit R-13)", () => {
  it("reads the uncompacted suffix once + one stats aggregate, never the full log", async () => {
    const { store, counts } = countingStore(await makeStore());
    const deps = { store } as unknown as TurnExecutorDeps;

    const state = await loadTurnSessionState({
      input: {
        origin: "player",
        sessionId: "sess-dedup",
        turnId: "turn-1",
        playerMessage: "hello",
      },
      deps,
      shouldAppendPlayerMessage: true,
    });

    expect(counts()).toEqual({
      listUncompactedTurnMessages: 1,
      getTurnMessageStats: 1,
    });
    expect(state.messageHistory).toHaveLength(1);
    const pending = state.journalMessages[0]!;
    expect(pending.content).toBe("hello");
    expect(pending.turnId).toBe("turn-1");
    expect(pending.sourceType).toBe("player");
    // Pending input is persisted only by finalizeExecution after proposals pass.
    expect(await store.listTurnMessages("sess-dedup")).toHaveLength(1);
    // turnNumber counts player messages BEFORE this turn's append.
    expect(state.turnNumber).toBe(1);
  });

  it("defers compaction until an agent supplies its assembled system prompt", async () => {
    const base = await makeStore();
    const { store, counts } = countingStore(base);
    const deps = {
      store,
      compactor: {
        run: async () => ({ compacted: false }),
      },
    } as unknown as TurnExecutorDeps;

    await loadTurnSessionState({
      input: {
        origin: "player",
        sessionId: "sess-dedup",
        turnId: "turn-1",
        playerMessage: "hello",
      },
      deps,
      shouldAppendPlayerMessage: true,
    });

    // Session loading performs one bounded read. Compaction now happens at the
    // first real agent assembly, where its system prompt is available, rather
    // than here with an empty preview.
    expect(counts()).toEqual({
      listUncompactedTurnMessages: 1,
      getTurnMessageStats: 1,
    });
  });

  it("excludes compacted rows from the loaded history while counts still cover the full log", async () => {
    const base = await makeStore();
    await base.tagTurnMessagesCompacted("sess-dedup", ["tm-0"], "summary-1");
    await base.withTransaction((tx) =>
      recordRuntimeTriggersTx(tx, {
        sessionId: "sess-dedup",
        runtimeIds: ["demo/narrator"],
        now: new Date().toISOString(),
      }),
    );

    const state = await loadTurnSessionState({
      input: {
        origin: "player",
        sessionId: "sess-dedup",
        turnId: "turn-1",
        playerMessage: "hello",
      },
      deps: { store: base } as unknown as TurnExecutorDeps,
      shouldAppendPlayerMessage: true,
    });

    // Compacted rows and the pending player input are absent from committed
    // in-memory history…
    expect(state.messageHistory.map((m) => m.id)).toEqual(
      state.messageHistory.map((m) => m.id).filter((id) => id !== "tm-0"),
    );
    expect(state.messageHistory).toHaveLength(0);
    expect(state.journalMessages).toHaveLength(1);
    expect(state.journalMessages[0]?.content).toBe("hello");
    // …but turnNumber still sees the whole committed log, and trigger history
    // comes from the ledger rather than the compacted journal.
    expect(state.turnNumber).toBe(1);
    expect(state.runtimeTriggerCounts.get("demo/narrator")).toBe(1);
    expect(state.runtimeTurnsSinceLastTrigger.get("demo/narrator")).toBe(1);
  });
});
