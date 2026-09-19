import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store";
import { createEventBus } from "@covel/events";
import type { RuntimeResult } from "@covel/shared";
import {
  commitExecution,
  type CommitExecutionArgs,
} from "../src/commit/commit-execution.js";

async function fixture() {
  const store = createMemoryStore();
  await store.createSession({
    id: "session",
    locale: "en-US",
    status: "active",
    phase: "playing",
    setupRuntimes: {},
    activePlugins: ["story"],
    completedPlayerTurns: 1,
    createdAt: "2026-09-18T00:00:00Z",
    updatedAt: "2026-09-18T00:00:00Z",
  });
  const eventBus = createEventBus();
  const events: string[] = [];
  eventBus.onEmit((event) => events.push(event.type));
  const updateAfterTurn = vi
    .fn()
    .mockResolvedValue({ updated: true, blocksChanged: [] });
  const result: RuntimeResult = {
    runtimeId: "story",
    pluginId: "story",
    runId: "run",
    turnId: "turn",
    status: "success",
    output: { narrativeOutput: "Committed story." },
    toolCalls: [],
    durationMs: 1,
    timestamp: "2026-09-18T00:00:00Z",
  };
  const args: CommitExecutionArgs = {
    store,
    sessionId: "session",
    eventBus,
    executionContext: {
      executionId: "run",
      origin: "manual",
      countPolicy: "none",
    },
    runtimes: [
      {
        name: "story",
        pluginId: "story",
        outputKind: "story",
        capabilities: [],
      },
    ],
    results: [result],
    turnIds: [],
    completion: { kind: "turn", turnId: "turn", durationMs: 1 },
    memorySystem: {
      manager: {
        initializeDefaults: async () => {},
        loadBlocks: async () => [
          { label: "scene", content: "old", updatedAt: "today" },
        ],
      },
      updater: { updateAfterTurn },
    },
  };
  return { args, store, events, updateAfterTurn, result };
}

describe("commitExecution lifecycle", () => {
  it("settles an aborted commit without waiting for prior memory or writing game state", async () => {
    const { args, store, updateAfterTurn } = await fixture();
    const controller = new AbortController();
    const waiting = Promise.withResolvers<void>();
    const memory = Promise.withResolvers<void>();
    const extraInTx = vi.fn();
    let settled = false;
    const commit = commitExecution({
      ...args,
      signal: controller.signal,
      extraInTx,
      memorySystem: {
        ...args.memorySystem!,
        updater: {
          updateAfterTurn,
          awaitPending: () => {
            waiting.resolve();
            return memory.promise;
          },
        },
      },
    }).then((result) => {
      settled = true;
      return result;
    });
    await waiting.promise;
    controller.abort();
    try {
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 200 });
      expect(await commit).toMatchObject({
        status: "failed",
        snapshotFailed: false,
      });
      expect(extraInTx).not.toHaveBeenCalled();
      expect(updateAfterTurn).not.toHaveBeenCalled();
      expect(await store.listMessages("session")).toEqual([]);
      expect(await store.listSnapshots("session")).toEqual([]);
    } finally {
      memory.resolve();
      await commit;
    }
  });

  it("drains prior memory before committing and publishes completion after the snapshot", async () => {
    const { args, store, events, updateAfterTurn } = await fixture();
    const order: string[] = [];
    const outcome = await commitExecution({
      ...args,
      memorySystem: {
        ...args.memorySystem!,
        updater: {
          updateAfterTurn: async (input) => {
            order.push("memory");
            expect(events).toContain("turn.completed");
            expect(await store.listSnapshots("session")).toHaveLength(1);
            return updateAfterTurn(input);
          },
          awaitPending: async () => {
            order.push("drain");
          },
        },
      },
      extraInTx: async () => {
        order.push("commit");
      },
      onFinalized: () => {
        order.push("delivery");
      },
    });
    expect(outcome.status).toBe("committed");
    expect(order).toEqual(["drain", "commit", "delivery", "memory"]);
    expect(events.indexOf("state.snapshot.created")).toBeLessThan(
      events.indexOf("turn.completed"),
    );
  });

  it("rolls back all writes and withholds every follow-up when the transaction fails", async () => {
    const { args, store, events, updateAfterTurn } = await fixture();
    const outcome = await commitExecution({
      ...args,
      extraInTx: async () => {
        throw new Error("transaction failed");
      },
    });
    expect(outcome.status).toBe("failed");
    expect(await store.listMessages("session")).toEqual([]);
    expect(await store.listSnapshots("session")).toEqual([]);
    expect(events).not.toContain("turn.completed");
    expect(updateAfterTurn).not.toHaveBeenCalled();
  });

  it("isolates transport and snapshot failures from durable success and memory", async () => {
    const { args, store, events, updateAfterTurn } = await fixture();
    const outcome = await commitExecution({
      ...args,
      store: {
        ...store,
        saveSnapshot: async () => {
          throw new Error("disk full");
        },
      },
      onFinalized: () => {
        throw new Error("transport closed");
      },
    });
    expect(outcome).toMatchObject({
      status: "committed",
      snapshotFailed: true,
    });
    expect(events.filter((event) => event === "turn.completed")).toHaveLength(
      1,
    );
    expect(updateAfterTurn).toHaveBeenCalledTimes(1);
  });

  it("does not make a committed execution retryable when memory preparation fails", async () => {
    const { args, events } = await fixture();
    const outcome = await commitExecution({
      ...args,
      memorySystem: {
        ...args.memorySystem!,
        manager: {
          initializeDefaults: async () => {},
          loadBlocks: async () => {
            throw new Error("memory unavailable");
          },
        },
      },
    });
    expect(outcome.status).toBe("committed");
    expect(events).toContain("turn.completed");
  });

  it.each(["suspended", "detached"] as const)(
    "checkpoints %s work without completing or ingesting it",
    async (kind) => {
      const { args, result, events, updateAfterTurn } = await fixture();
      const outcome = await commitExecution({
        ...args,
        ...(kind === "suspended"
          ? {
              results: [
                { ...result, status: "suspended" as const, output: null },
              ],
            }
          : { completion: { kind: "detached" as const, turnId: "turn" } }),
      });
      expect(outcome.status).toBe("committed");
      expect(events).toContain("state.snapshot.created");
      expect(events).not.toContain("turn.completed");
      expect(updateAfterTurn).not.toHaveBeenCalled();
    },
  );

  it("forces a resumed checkpoint and only ingests current successful story results", async () => {
    const { args, result, store, events, updateAfterTurn } = await fixture();
    await store.updateSession("session", { completedPlayerTurns: 2 });
    const outcome = await commitExecution({
      ...args,
      completion: {
        kind: "resume",
        turnId: "turn",
        suspensionId: "susp",
        pluginId: "story",
        runtimeId: "story",
      },
      runtimes: [
        ...args.runtimes,
        { name: "helper", pluginId: "helper", outputKind: "system" },
      ],
      results: [
        result,
        { ...result, turnId: "old-turn" },
        { ...result, runtimeId: "helper" },
      ],
    });
    expect(outcome.status).toBe("committed");
    expect(events).toContain("turn.resumed");
    expect(events).not.toContain("turn.completed");
    expect(await store.listSnapshots("session")).toHaveLength(1);
    expect(updateAfterTurn.mock.calls[0][0].narrativeText).toBe(
      "Committed story.",
    );
  });
});
