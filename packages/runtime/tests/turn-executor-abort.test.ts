/**
 * W4 player abort at the turn-executor level: once the abort signal fires,
 * no further runtime groups are scheduled, the event chain is skipped, and
 * the TurnResult carries `abortReason: "aborted-by-player"`. Results from
 * runtimes that completed before the abort are preserved.
 */

import { describe, it, expect } from "vitest";
import type { RuntimeManifest, TurnInput } from "@covel/shared";
import { createMemoryStore } from "@covel/store";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor.js";
import { PLAYER_ABORT_REASON } from "../src/turn-executor/turn-control.js";
import type { LLMAdapter, LLMResponse } from "../src/llm/llm-adapter.js";

function manifest(
  name: string,
  priority: number,
  overrides?: Partial<RuntimeManifest>,
): RuntimeManifest {
  return {
    name,
    pluginId: name.split("/")[0],
    description: name,
    priority,
    outputKind: "story",
    trigger: { type: "auto" },
    ...overrides,
  } as RuntimeManifest;
}

const input: TurnInput = {
  sessionId: "sess-abort",
  turnId: "turn-abort",
  playerMessage: "go",
};

function prose(content: string): LLMResponse {
  return {
    content,
    toolCalls: [],
    finishReason: "stop",
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

describe("executeTurn player abort", () => {
  it("stops scheduling later groups and surfaces abortReason; earlier results survive", async () => {
    const controller = new AbortController();
    const calledRuntimes: string[] = [];
    // Runtime A completes normally, but the player aborts while it runs;
    // runtime B (a later priority group) must never execute.
    const llm: LLMAdapter = {
      generate: async (params: { messages: readonly unknown[] }) => {
        void params;
        calledRuntimes.push("call");
        controller.abort(); // player pressed stop mid-turn
        return prose("finished before the signal was observed");
      },
    } as LLMAdapter;

    const store = createMemoryStore();
    const deps: TurnExecutorDeps = {
      loadRuntime: async (m) => ({ manifest: m, promptTemplate: "prompt" }),
      llm,
      store,
      turnControl: { signal: controller.signal },
    };

    const result = await executeTurn(
      input,
      [
        manifest("plug-a", 500),
        // Depends on plug-a so the DAG scheduler puts it in a later group —
        // the abort fired during plug-a must prevent it from running.
        manifest("plug-b", 600, {
          input: {
            inject: [
              {
                kind: "runtime",
                from: "plug-a",
                field: "narrativeOutput",
                as: "upstream",
              },
            ],
          },
        } as Partial<RuntimeManifest>),
      ],
      deps,
      { maxSteps: 3 },
    );

    // Only the first group's runtime ever reached the LLM.
    expect(calledRuntimes).toHaveLength(1);
    expect(result.abortReason).toBe(PLAYER_ABORT_REASON);
    const ids = result.runtimeResults.map((r) => r.runtimeId);
    expect(ids).toContain("plug-a");
    expect(ids).not.toContain("plug-b");
  });

  it("threads the player abort signal into function-runtime handler context", async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    let observedAbortedFlag: boolean | undefined;
    const store = createMemoryStore();
    const deps: TurnExecutorDeps = {
      loadRuntime: async (m) => ({
        manifest: m,
        promptTemplate: "prompt",
        handler: async (ctx: { signal?: AbortSignal }) => {
          observedSignal = ctx.signal;
          // Player aborts while the handler runs; a cooperative handler
          // reading ctx.signal.aborted sees the flip, so long provider work
          // can cancel instead of running to completion.
          controller.abort();
          observedAbortedFlag = ctx.signal?.aborted;
          return { narrativeOutput: "done" };
        },
      }),
      llm: { generate: async () => prose("unused") } as LLMAdapter,
      store,
      turnControl: { signal: controller.signal },
    };

    await executeTurn(
      input,
      [manifest("fn-plug", 500, { runtimeType: "function" })],
      deps,
      { maxSteps: 3 },
    );

    // H-09: handlers receive a MERGED signal (player abort + deadline), so
    // identity with the player signal no longer holds — the merged signal
    // must mirror the player abort state.
    expect(observedSignal).toBeDefined();
    expect((observedSignal as AbortSignal).aborted).toBe(true);
    expect(observedAbortedFlag).toBe(true);
  });

  it("without an abort the same setup runs every group and sets no abortReason", async () => {
    const calledRuntimes: string[] = [];
    const llm: LLMAdapter = {
      generate: async () => {
        calledRuntimes.push("call");
        return prose("ok");
      },
    } as LLMAdapter;
    const store = createMemoryStore();
    const deps: TurnExecutorDeps = {
      loadRuntime: async (m) => ({ manifest: m, promptTemplate: "prompt" }),
      llm,
      store,
    };

    const result = await executeTurn(
      input,
      [manifest("plug-a", 500), manifest("plug-b", 600)],
      deps,
      { maxSteps: 3 },
    );

    expect(calledRuntimes).toHaveLength(2);
    expect(result.abortReason).toBeUndefined();
    expect(result.runtimeResults.map((r) => r.runtimeId).sort()).toEqual([
      "plug-a",
      "plug-b",
    ]);
  });
});
