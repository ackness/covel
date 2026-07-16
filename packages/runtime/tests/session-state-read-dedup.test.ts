import { describe, expect, it } from "vitest";
import { createMemoryStore } from "@covel/store";
import type { DataStore } from "@covel/store";
import { loadTurnSessionState } from "../src/turn-executor/session-state.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor-types.js";

/**
 * Audit 2026-07-11 R-13: loadTurnSessionState used to full-read
 * listTurnMessages twice per turn (before and after appending the player
 * message). The appended record is now concatenated locally; these tests pin
 * the single read and that the returned history still includes the player
 * message.
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
  counts: () => number;
} {
  let listTurnMessagesCalls = 0;
  const wrapped = new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "listTurnMessages" && typeof value === "function") {
        return (...args: unknown[]) => {
          listTurnMessagesCalls += 1;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { store: wrapped, counts: () => listTurnMessagesCalls };
}

describe("loadTurnSessionState read dedup (audit R-13)", () => {
  it("reads listTurnMessages once when appending the player message (no compactor)", async () => {
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

    expect(counts()).toBe(1);
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

  it("re-reads after compaction actually runs", async () => {
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

    // One initial read + the post-compaction reload; the pre-append second
    // full read is gone.
    expect(counts()).toBe(2);
  });
});
