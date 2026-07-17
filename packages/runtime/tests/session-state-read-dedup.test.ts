import { describe, expect, it } from "vitest";
import { createMemoryStore } from "@covel/store";
import type { DataStore } from "@covel/store";
import { loadTurnSessionState } from "../src/turn-executor/session-state.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor-types.js";

/**
 * Audit 2026-07-11 R-13 + 2026-07-17 bounded-history follow-up:
 * loadTurnSessionState used to full-read listTurnMessages twice per turn.
 * Today the per-turn reads are (a) one listUncompactedTurnMessages for the
 * raw suffix, (b) one getTurnMessageStats aggregate for turnNumber / trigger
 * counts — never a full listTurnMessages. The appended player record is
 * concatenated locally; these tests pin the read pattern and that the
 * returned history still includes the player message.
 */

async function makeStore(): Promise<DataStore> {
  const store = createMemoryStore();
  const now = new Date().toISOString();
  await store.createSession({
    id: "sess-dedup",
    worldId: "w1",
    status: "active",
    turnCount: 1,
    preGameCompleted: [],
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
    // History includes both the pre-existing message and the appended one.
    expect(state.messageHistory).toHaveLength(2);
    const appended = state.messageHistory[1]!;
    expect(appended.content).toBe("hello");
    expect(appended.turnId).toBe("turn-1");
    expect(appended.sourceType).toBe("player");
    // The appended record was actually persisted, not just concatenated.
    expect(await store.listTurnMessages("sess-dedup")).toHaveLength(2);
    // turnNumber counts player messages BEFORE this turn's append.
    expect(state.turnNumber).toBe(1);
  });

  it("re-reads the uncompacted suffix after compaction actually runs", async () => {
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
        sessionId: "sess-dedup",
        turnId: "turn-1",
        playerMessage: "hello",
      },
      deps,
      shouldAppendPlayerMessage: true,
    });

    // One initial read + the post-compaction reload; the stats aggregate
    // still runs exactly once and the full log is never read.
    expect(counts()).toEqual({
      listUncompactedTurnMessages: 2,
      getTurnMessageStats: 1,
    });
  });

  it("excludes compacted rows from the loaded history while counts still cover the full log", async () => {
    const base = await makeStore();
    const now = new Date().toISOString();
    await base.appendTurnMessage({
      id: "tm-runtime-old",
      sessionId: "sess-dedup",
      turnId: "turn-0",
      sourceType: "runtime",
      sourceRuntimeId: "demo/narrator",
      role: "assistant",
      content: "old narrative",
      order: 1,
      createdAt: now,
    });
    await base.tagTurnMessagesCompacted(
      "sess-dedup",
      ["tm-0", "tm-runtime-old"],
      "summary-1",
    );

    const state = await loadTurnSessionState({
      input: {
        sessionId: "sess-dedup",
        turnId: "turn-1",
        playerMessage: "hello",
      },
      deps: { store: base } as unknown as TurnExecutorDeps,
      shouldAppendPlayerMessage: true,
    });

    // Compacted rows are absent from the in-memory history…
    expect(state.messageHistory.map((m) => m.id)).toEqual(
      state.messageHistory.map((m) => m.id).filter((id) => id !== "tm-0"),
    );
    expect(state.messageHistory).toHaveLength(1);
    // …but turnNumber / trigger counts still see the whole log.
    expect(state.turnNumber).toBe(1);
    expect(state.runtimeTriggerCounts.get("demo/narrator")).toBe(1);
  });
});
