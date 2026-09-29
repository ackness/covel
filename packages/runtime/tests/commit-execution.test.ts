import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
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
    eventBus,
    execution: {
      result,
      commit: {
        sessionId: "session",
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
            outputContract: undefined,
          },
        ],
        results: [result],
        turnIds: [],
        outputSchemas: {},
      },
    },
    completion: { kind: "turn", turnId: "turn", durationMs: 1 },
  };
  return { args, store, events, result };
}

describe("commitExecution lifecycle", () => {
  it("publishes completion after durable delivery and the snapshot", async () => {
    const { args, events } = await fixture();
    const order: string[] = [];
    const outcome = await commitExecution({
      ...args,
      extraInTx: async () => {
        order.push("commit");
      },
      onFinalized: () => {
        order.push("delivery");
      },
    });
    expect(outcome.status).toBe("committed");
    expect(order).toEqual(["commit", "delivery"]);
    expect(events.indexOf("state.snapshot.created")).toBeLessThan(
      events.indexOf("turn.completed"),
    );
  });

  it("rolls back all writes and withholds every follow-up when the transaction fails", async () => {
    const { args, store, events } = await fixture();
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
  });

  it("isolates transport and snapshot failures from durable success", async () => {
    const { args, store, events } = await fixture();
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
  });

  it.each(["suspended", "detached"] as const)(
    "checkpoints %s work without completing or ingesting it",
    async (kind) => {
      const { args, result, events } = await fixture();
      const outcome = await commitExecution({
        ...args,
        ...(kind === "suspended"
          ? {
              execution: {
                ...args.execution,
                commit: {
                  ...args.execution.commit,
                  results: [
                    { ...result, status: "suspended" as const, output: null },
                  ],
                },
              },
            }
          : { completion: { kind: "detached" as const, turnId: "turn" } }),
      });
      expect(outcome.status).toBe("committed");
      expect(events).toContain("state.snapshot.created");
      expect(events).not.toContain("turn.completed");
    },
  );

  it("forces a resumed checkpoint", async () => {
    const { args, result, store, events } = await fixture();
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
      execution: {
        ...args.execution,
        commit: {
          ...args.execution.commit,
          runtimes: [
            ...args.execution.commit.runtimes,
            { name: "helper", pluginId: "helper", outputKind: "system" },
          ],
          results: [
            result,
            { ...result, turnId: "old-turn" },
            { ...result, runtimeId: "helper" },
          ],
        },
      },
    });
    expect(outcome.status).toBe("committed");
    expect(events).toContain("turn.resumed");
    expect(events).not.toContain("turn.completed");
    expect(await store.listSnapshots("session")).toHaveLength(1);
  });
});
