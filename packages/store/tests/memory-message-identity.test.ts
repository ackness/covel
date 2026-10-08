import { afterEach, describe, expect, it, vi } from "vitest";
import * as memoryStateModule from "../src/memory/memory-state.js";
import { createMemoryStore } from "../src/memory-entry.js";
import {
  exportSessionCheckpoint,
  replaceSessionFromCheckpoint,
} from "../src/index.js";
import { makeMessage, makeSession } from "../src/contract/test-fixtures.js";

afterEach(() => vi.restoreAllMocks());

describe("Memory message identity lookup on checkpoint import", () => {
  it("uses one identity lookup per message instead of scanning the accumulated checkpoint", async () => {
    const observations = [];
    for (const [count, otherSessionMessages] of [
      [128, 0],
      [256, 0],
      [128, 17],
    ] as const) {
      const state = memoryStateModule.createMemoryState();
      vi.spyOn(memoryStateModule, "createMemoryState").mockReturnValue(state);
      const store = createMemoryStore();
      let comparisons = 0;
      let lookups = 0;
      const some = state.messages.some.bind(state.messages);
      vi.spyOn(state.messages, "some").mockImplementation(
        (predicate, thisArg) =>
          some((message, index, rows) => {
            comparisons++;
            return predicate.call(thisArg, message, index, rows);
          }),
      );
      const positions = (
        state as typeof state & { messagePositions?: Map<string, number> }
      ).messagePositions;
      if (positions) {
        const has = positions.has.bind(positions);
        vi.spyOn(positions, "has").mockImplementation((id) => {
          lookups++;
          return has(id);
        });
      }
      try {
        await store.createSession(makeSession({ id: "imported" }));
        await store.createSession(makeSession({ id: "other" }));
        for (let index = 0; index < otherSessionMessages; index++) {
          await store.addMessage(
            makeMessage({ id: `other-${index}`, sessionId: "other" }),
          );
        }
        const checkpoint = await exportSessionCheckpoint(store, "imported", {
          revision: 1,
          actionId: "identity-count",
        });
        comparisons = 0;
        lookups = 0;
        await replaceSessionFromCheckpoint(store, {
          ...checkpoint,
          messages: Array.from({ length: count }, (_, index) =>
            makeMessage({
              id: `imported-${index}`,
              sessionId: "imported",
              createdAt: "2026-01-01T00:00:00.000Z",
            }),
          ),
        });
        expect(await store.listMessages("imported")).toHaveLength(count);
        expect(await store.listMessages("other")).toHaveLength(
          otherSessionMessages,
        );
        observations.push({
          count,
          otherSessionMessages,
          comparisons,
          lookups,
        });
      } finally {
        await store.close();
        vi.restoreAllMocks();
      }
    }
    console.info(
      "checkpoint identity operations",
      JSON.stringify(observations),
    );
    expect(observations).toEqual([
      { count: 128, otherSessionMessages: 0, comparisons: 0, lookups: 128 },
      { count: 256, otherSessionMessages: 0, comparisons: 0, lookups: 256 },
      { count: 128, otherSessionMessages: 17, comparisons: 0, lookups: 128 },
    ]);
  });

  it("rolls back replacement and its inserted identities when another session owns a message ID", async () => {
    const store = createMemoryStore();
    try {
      const session = makeSession({ id: "imported" });
      await store.createSession(session);
      await store.createSession(makeSession({ id: "other" }));
      const original = makeMessage({ id: "original", sessionId: "imported" });
      const occupied = makeMessage({ id: "occupied", sessionId: "other" });
      await store.addMessage(original);
      await store.addMessage(occupied);
      const checkpoint = await exportSessionCheckpoint(store, "imported", {
        revision: 1,
        actionId: "collision",
      });
      const preceding = makeMessage({ id: "preceding", sessionId: "imported" });
      await expect(
        replaceSessionFromCheckpoint(store, {
          ...checkpoint,
          messages: [preceding, { ...occupied, sessionId: "imported" }],
        }),
      ).rejects.toThrow();
      expect(await store.getSession("imported")).toEqual(session);
      expect(await store.listMessages("imported")).toEqual([original]);
      expect(await store.listMessages("other")).toEqual([occupied]);
      await expect(store.addMessage(original)).rejects.toThrow();
      await store.addMessage(preceding);
      expect(await store.listMessages("imported")).toHaveLength(2);
    } finally {
      await store.close();
    }
  });
});
