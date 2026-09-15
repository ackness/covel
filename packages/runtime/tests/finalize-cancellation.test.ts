import { afterEach, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import type { HookResult } from "../src/hooks/types.js";
import {
  finalizeExecution,
  type FinalizeExecutionOutcome,
} from "../src/commit/finalize-execution.js";

afterEach(() => vi.useRealTimers());

const execution = {
  sessionId: "cancel-commit",
  executionContext: {
    executionId: "turn-cancel-commit",
    origin: "player" as const,
    countPolicy: "none" as const,
  },
  runtimes: [{ name: "fixture", pluginId: "fixture", outputKind: "plugin" }],
  results: [
    {
      pluginId: "fixture",
      runtimeId: "fixture",
      turnId: "turn-cancel-commit",
      status: "success",
      output: {
        statePatches: [1, 2, 3].map((value) => ({
          table: "stats",
          field: `hp${value}`,
          value,
        })),
      },
    },
  ],
  turnIds: [],
};

it("cancels a blocked commit hook, rolls back earlier writes and skips later proposals", async () => {
  vi.useFakeTimers();
  const store = createMemoryStore();
  const hookPipeline = createHookPipeline();
  const parent = new AbortController();
  const started = Promise.withResolvers<AbortSignal>();
  const blocked = Promise.withResolvers<HookResult>();
  let calls = 0;
  hookPipeline.register({
    id: "blocked-commit",
    event: "PreStateCommit",
    handler: async (ctx) => {
      if (++calls === 2) {
        started.resolve(ctx.signal!);
        return blocked.promise;
      }
      return { action: "continue" };
    },
  });
  let outcome: FinalizeExecutionOutcome | undefined;
  const running = finalizeExecution({
    ...execution,
    store,
    hookPipeline,
    signal: parent.signal,
  }).then((result) => {
    outcome = result;
  });
  try {
    const signal = await started.promise;
    parent.abort(new Error("synthetic-player-stop"));
    await vi.advanceTimersByTimeAsync(0);
    expect(signal.aborted).toBe(true);
    expect(outcome?.status).toBe("failed");
    expect(calls).toBe(2);
    expect(
      await store.getStateEntry(execution.sessionId, "stats", "hp1"),
    ).toBeNull();
    expect(
      await store.getStateEntry(execution.sessionId, "stats", "hp3"),
    ).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    // Release the fixture even if an assertion fails against a regression.
    blocked.resolve({ action: "continue" });
    await vi.advanceTimersByTimeAsync(0);
    await running;
  }
});

it("finishes post-commit hooks when cancellation arrives after the transaction", async () => {
  const store = createMemoryStore();
  const hookPipeline = createHookPipeline();
  const parent = new AbortController();
  const observed: boolean[] = [];
  hookPipeline.register({
    id: "committed-observer",
    event: "PostStateCommit",
    handler: async (ctx) => {
      parent.abort();
      observed.push(ctx.signal!.aborted);
      return { action: "continue" };
    },
  });
  const result = await finalizeExecution({
    ...execution,
    store,
    hookPipeline,
    signal: parent.signal,
  });
  expect(result.status).toBe("committed");
  expect(observed).toEqual([false, false, false]);
  expect(
    await store.getStateEntry(execution.sessionId, "stats", "hp3"),
  ).toMatchObject({ value: 3 });
});
