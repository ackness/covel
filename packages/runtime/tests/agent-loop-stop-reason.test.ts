/**
 * Every exit of the agent tool loop gets one stop reason. One case per row of
 * the exit table: the loop's own exits on `AgentToolLoopCompleted.stop`, the
 * settled and finalized `RuntimeResult.stop`, and thrown exits through the
 * tag the loop puts on the error.
 */

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { suspendTool, tool } from "@covel/tools";
import type { RuntimeResult } from "@covel/shared";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";
import { settleAgentLoop } from "../src/agent-loop/settle-agent-loop.js";
import {
  classifyLoopError,
  stopOf,
  tagStop,
} from "../src/agent-loop/stop-reason.js";
import { createAgentLoopBudget } from "../src/agent-loop/agent-loop-budget.js";
import { runPostRuntimeHook } from "../src/hooks/wire-helpers.js";
import {
  RuntimeTimeoutError,
  TurnAbortedError,
} from "../src/turn-executor/turn-control.js";
import type { AgentToolLoopCompleted } from "../src/agent-loop/turn-agent-tool-loop.js";
import {
  doneTool,
  input,
  makeExecutor,
  manifest,
  markTool,
  prose,
  queuedLLM,
  runLoop,
  runRuntime,
  saveTool,
  scriptedLLM,
  toolCall,
} from "./_helpers/agent-loop-fixture.js";

async function thrownBy(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
  } catch (error) {
    return error;
  }
  throw new Error("expected the loop to throw");
}

/** A tool that waits until its signal fires (or `ms` passes). */
function slowTool(ms: number, onEnter?: () => void) {
  return tool({
    name: "mark",
    description: "waits",
    parameters: z.object({ note: z.string() }),
    async execute(_args, context) {
      onEnter?.();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        context.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      return { waited: true };
    },
  });
}

describe("the loop's own exits", () => {
  it("E1: a reply without tool calls is completed", async () => {
    const result = await runLoop({ llm: queuedLLM([prose("done")]) });
    expect(result.stop).toEqual({ reason: "completed" });
  });

  it("E2: runtime-done is tool-finished", async () => {
    const result = await runLoop({
      llm: queuedLLM([
        toolCall("mark", { note: "a" }),
        toolCall("runtime-done", {}, "tc-done"),
      ]),
      deps: { toolExecutor: makeExecutor([markTool, doneTool]) },
    });
    expect(result.stop).toEqual({ reason: "tool-finished" });
  });

  it("E3: a PostToolUse terminate is tool-finished", async () => {
    const hookPipeline = createHookPipeline();
    hookPipeline.register({
      id: "stop",
      event: "PostToolUse",
      handler: async () => ({
        action: "continue",
        replace: { terminate: true },
      }),
    });
    const llm = queuedLLM([toolCall("mark", { note: "a" }), prose("late")]);
    const result = await runLoop({ llm, hookPipeline });
    expect(result.stop).toEqual({ reason: "tool-finished" });
    expect(llm.requests).toHaveLength(1);
  });

  it("E4: completeAfterTools is tool-finished", async () => {
    const result = await runLoop({
      llm: queuedLLM([toolCall("mark", { note: "a" })]),
      manifest: manifest({ completeAfterTools: ["mark"] }),
    });
    expect(result.stop).toEqual({ reason: "tool-finished" });
  });
});

describe("the step limit (E5)", () => {
  it("fails without a finalizer when prose cannot satisfy requireToolUse", async () => {
    // `save` is the only completing tool, and the model only ever reads.
    let n = 0;
    const llm = scriptedLLM(() =>
      toolCall("mark", { note: `n${n}` }, `tc-${n++}`, "scratch text"),
    );
    const result = await runRuntime({
      llm,
      manifest: manifest({
        maxSteps: 2,
        requireToolUse: true,
        completeAfterTools: ["save"],
        tools: { plugin: ["mark", "save"] },
      }),
      deps: { toolExecutor: makeExecutor([markTool, saveTool]) },
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("exhausted the tool loop after 2 steps");
    expect(result.stop).toEqual({ reason: "max-steps" });
    expect(result.output).toBeNull();
    // No finalizer request: two steps, two calls.
    expect(llm.requests).toHaveLength(2);
  });

  // The regression for the fix: before, the scratch text beside the last
  // tool call made this a success.
  it("succeeds only through the finalizer, with its text, not the scratch", async () => {
    let n = 0;
    const llm = scriptedLLM((params) =>
      params.tools
        ? toolCall("mark", { note: `n${n}` }, `tc-${n++}`, "scratch text")
        : prose("the final answer"),
    );
    const result = await runRuntime({
      llm,
      manifest: manifest({ maxSteps: 2 }),
    });
    expect(result.status).toBe("success");
    expect(result.stop).toEqual({ reason: "max-steps", finalizer: true });
    expect(JSON.stringify(result.output)).not.toContain("scratch text");
    expect(llm.requests).toHaveLength(3);
    expect(llm.requests[2]?.tools).toBeUndefined();
    expect(llm.requests[2]?.defaults?.toolChoice).toBeUndefined();
    expect(llm.requests[2]?.messages.at(-1)).toMatchObject({
      role: "system",
      content: expect.stringContaining("No steps are left"),
    });
    // The finalizer's tool calls never run: only the two steps' calls.
    expect(result.toolCalls).toHaveLength(2);
  });

  it("hands the loop the finalizer's text in place of the scratch", async () => {
    let n = 0;
    const result = await runLoop({
      llm: scriptedLLM((params) =>
        params.tools
          ? toolCall("mark", { note: `n${n}` }, `tc-${n++}`, "scratch text")
          : prose("the final answer"),
      ),
      maxSteps: 2,
    });
    expect(result.stop).toEqual({ reason: "max-steps", finalizer: true });
    expect(result.finalContent).toBe("the final answer");
  });

  it("fails when the finalizer writes nothing", async () => {
    let n = 0;
    const llm = scriptedLLM((params) =>
      params.tools
        ? toolCall("mark", { note: `n${n}` }, `tc-${n++}`, "scratch text")
        : prose("   "),
    );
    const result = await runRuntime({
      llm,
      manifest: manifest({ maxSteps: 2 }),
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("exhausted the tool loop after 2 steps");
    expect(result.stop).toEqual({ reason: "max-steps" });
  });

  it("fails when the finalizer's model call fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let n = 0;
      const llm = scriptedLLM((params) => {
        if (!params.tools) throw new Error("PROVIDER_ERROR: finalizer down");
        return toolCall("mark", { note: `n${n}` }, `tc-${n++}`, "scratch");
      });
      const result = await runRuntime({
        llm,
        manifest: manifest({ maxSteps: 1 }),
      });
      expect(result.status).toBe("failed");
      expect(result.stop).toEqual({ reason: "max-steps" });
    } finally {
      warn.mockRestore();
    }
  });

  it("asks a story for its narrative and keeps the finalizer's text", async () => {
    let n = 0;
    const llm = scriptedLLM((params) =>
      params.tools
        ? toolCall("mark", { note: `n${n}` }, `tc-${n++}`, "Looking up...")
        : prose("The fog closes over the pier."),
    );
    const result = await runLoop({
      llm,
      manifest: manifest({ outputKind: "story" }),
      maxSteps: 2,
    });
    expect(result.stop).toEqual({ reason: "max-steps", finalizer: true });
    expect(result.finalContent).toBe("The fog closes over the pier.");
    expect(llm.requests.at(-1)?.messages.at(-1)?.content).toContain(
      "have not written the story",
    );
  });

  it("skips the finalizer when the output comes from a completing tool", async () => {
    // The completing tool succeeded beside a failed call, so the batch does
    // not complete and the contract is met: only the output channel rules
    // the finalizer out.
    const llm = scriptedLLM((params) =>
      params.tools
        ? {
            content: "scratch",
            toolCalls: [
              { id: "tc-save", name: "save", arguments: "{}" },
              { id: "tc-bad", name: "mark", arguments: "{}" },
            ],
            finishReason: "tool_calls",
            usage: { inputTokens: 1, outputTokens: 1 },
          }
        : prose("never"),
    );
    const result = await runLoop({
      llm,
      maxSteps: 1,
      manifest: manifest({
        requireToolUse: true,
        completeAfterTools: ["save"],
        tools: { plugin: ["mark", "save"] },
      }),
      loaded: {
        promptTemplate: "prompt",
        outputSchema: {
          type: "object",
          properties: { saved: { type: "boolean" } },
        },
      } as never,
      deps: { toolExecutor: makeExecutor([markTool, saveTool]) },
    });
    expect(result.stop).toEqual({ reason: "max-steps" });
    expect(llm.requests).toHaveLength(1);
  });

  it("skips the finalizer when too little time is left", async () => {
    let n = 0;
    const llm = scriptedLLM((params) =>
      params.tools
        ? toolCall("mark", { note: `n${n}` }, `tc-${n++}`, "scratch")
        : prose("never"),
    );
    const result = await runLoop({ llm, maxSteps: 1, timeoutMs: 2_000 });
    expect(result.stop).toEqual({ reason: "max-steps" });
    expect(llm.requests).toHaveLength(1);
  });
});

describe("the deadline (E6) and cancellation (E7)", () => {
  it("E6: settles a deadline exit as a failure with the timeout text", () => {
    const toolLoop: AgentToolLoopCompleted = {
      finalContent: "scratch",
      finalToolOutput: null,
      collectedToolCalls: [],
      executedToolCalls: [],
      failedToolCalls: [],
      pendingProposals: [],
      emittedEvents: [],
      streamDeltaCount: 0,
      stop: { reason: "deadline" },
      effectiveMaxSteps: 5,
      deadline: Date.now(),
      requiredToolUseUnmet: false,
      requiredCompletionUnmet: false,
    };
    const settled = settleAgentLoop({
      manifest: manifest(),
      input,
      runId: "run",
      startTime: Date.now(),
      toolLoop,
    });
    expect(settled.kind).toBe("failed");
    expect(settled.result.error).toContain("timed out while waiting");
    expect(settled.result.stop).toEqual({ reason: "deadline" });
  });

  it("E6: the runtime's own timer gives deadline on the failed result", async () => {
    const result = await runRuntime({
      llm: queuedLLM([toolCall("mark", { note: "a" })]),
      manifest: manifest({ timeoutMs: 40 }),
      deps: { toolExecutor: makeExecutor([slowTool(2_000)]) },
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("timed out after 40ms");
    expect(result.stop).toEqual({ reason: "deadline" });
  });

  it("E7: a player abort is cancelled by the player", async () => {
    const controller = new AbortController();
    const error = await thrownBy(
      runLoop({
        llm: queuedLLM([toolCall("mark", { note: "a" })]),
        deps: {
          toolExecutor: makeExecutor([
            slowTool(2_000, () => controller.abort()),
          ]),
          turnControl: { signal: controller.signal },
        },
      }),
    );
    expect(error).toBeInstanceOf(TurnAbortedError);
    expect(stopOf(error, "run-loop")).toEqual({
      reason: "cancelled",
      cancelledBy: "player",
    });
  });

  it("E7: a parent's abort is cancelled by the parent", async () => {
    const controller = new AbortController();
    const parentTimeout = new RuntimeTimeoutError("parent timed out");
    const error = await thrownBy(
      runLoop({
        llm: queuedLLM([toolCall("mark", { note: "a" })]),
        deps: {
          toolExecutor: makeExecutor([
            slowTool(2_000, () => controller.abort(parentTimeout)),
          ]),
          turnControl: { executionSignal: controller.signal },
        },
      }),
    );
    expect(error).toBe(parentTimeout);
    expect(stopOf(error, "run-loop")).toEqual({
      reason: "cancelled",
      cancelledBy: "parent",
    });
  });

  it("E7: the loop's own timer is deadline, not a parent cancellation", async () => {
    const error = await thrownBy(
      runLoop({
        llm: queuedLLM([toolCall("mark", { note: "a" })]),
        timeoutMs: 40,
        deps: { toolExecutor: makeExecutor([slowTool(2_000)]) },
      }),
    );
    expect(error).toBeInstanceOf(RuntimeTimeoutError);
    expect(stopOf(error, "run-loop")).toEqual({ reason: "deadline" });
  });

  it("classifies by who fired, before any call-site tag", () => {
    const budget = createAgentLoopBudget(10_000, "probe", undefined);
    try {
      const tagged = new Error("model failed");
      tagStop(tagged, { reason: "model-error" }, "run");
      expect(classifyLoopError(tagged, budget, undefined, "run")).toEqual({
        reason: "model-error",
      });
      expect(
        classifyLoopError(new Error("bug"), budget, undefined, "run"),
      ).toBe(undefined);
      expect(
        classifyLoopError(
          new RuntimeTimeoutError("x"),
          budget,
          undefined,
          "run",
        ),
      ).toEqual({ reason: "cancelled", cancelledBy: "parent" });
      const player = new AbortController();
      player.abort();
      expect(
        classifyLoopError(tagged, budget, { signal: player.signal }, "run"),
      ).toEqual({ reason: "cancelled", cancelledBy: "player" });
      expect(budget.expired()).toBe(false);
    } finally {
      budget.close();
    }
  });
});

describe("thrown exits (E8–E11)", () => {
  it("E8: a provider failure is model-error, on the error and the result", async () => {
    const failing = scriptedLLM(() => {
      throw new Error("PROVIDER_ERROR: upstream exploded");
    });
    const error = await thrownBy(runLoop({ llm: failing }));
    expect(stopOf(error, "run-loop")).toEqual({ reason: "model-error" });

    const result = await runRuntime({ llm: failing });
    expect(result.status).toBe("failed");
    expect(result.stop).toEqual({ reason: "model-error" });
  });

  it("E9: a third rejected draft is invalid-output", async () => {
    const hookPipeline = createHookPipeline();
    hookPipeline.register({
      id: "review",
      event: "PostLLMResponse",
      handler: async () => ({
        action: "continue",
        replace: { correction: "Try again." },
      }),
    });
    const error = await thrownBy(
      runLoop({ llm: queuedLLM([prose("draft")]), hookPipeline }),
    );
    expect(String(error)).toContain("Response validation failed");
    expect(stopOf(error, "run-loop")).toEqual({ reason: "invalid-output" });
  });

  it("returns a context-overflow stop without throwing or losing tool calls", async () => {
    const result = await runLoop({
      manifest: manifest({ loopProfile: { finalizer: { maxSteps: false } } }),
      llm: queuedLLM([
        toolCall("mark", { note: "x".repeat(3_000) }),
        prose("unreached"),
      ]),
      maxSteps: 3,
      estimator: (text) => text.length,
      contextBudget: { maxInputTokens: 1_000, reservedForResponse: 100 },
    });
    expect(result.stop).toEqual({ reason: "context-overflow" });
    expect(result.stopMessage).toMatch(/Context budget exceeded/);
    expect(result.collectedToolCalls).toHaveLength(1);
  });

  it("E11: a second loop detection is loop-detected", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let i = 0;
      const error = await thrownBy(
        runLoop({
          llm: scriptedLLM(() =>
            toolCall("mark", { note: "same" }, `tc-${i++}`),
          ),
          maxSteps: 20,
        }),
      );
      expect(String(error)).toContain("tool-loop detected");
      expect(stopOf(error, "run-loop")).toEqual({ reason: "loop-detected" });
    } finally {
      warn.mockRestore();
    }
  });

  it("E11: a story's first detection does not stop the loop", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let i = 0;
      const result = await runLoop({
        llm: scriptedLLM((params) =>
          params.tools
            ? toolCall("mark", { note: "same" }, `tc-${i++}`)
            : prose("The fog closes over the pier."),
        ),
        manifest: manifest({ outputKind: "story" }),
        maxSteps: 20,
      });
      expect(result.stop).toEqual({ reason: "completed" });
    } finally {
      warn.mockRestore();
    }
  });

  it("an error no call site classifies stays untagged", async () => {
    const broken = tool({
      name: "mark",
      description: "broken",
      parameters: z.object({ note: z.string() }),
      async execute() {
        return { ok: true };
      },
    });
    const executor = makeExecutor([broken]);
    const error = await thrownBy(
      runLoop({
        llm: queuedLLM([toolCall("mark", { note: "a" })]),
        deps: {
          toolExecutor: {
            ...executor,
            getToolInfo: executor.getToolInfo.bind(executor),
            execute: async () => {
              throw new Error("executor bug");
            },
          },
        },
      }),
    );
    expect(String(error)).toContain("executor bug");
    expect(stopOf(error, "run-loop")).toBeUndefined();
  });
});

describe("suspension (E12) and settle failures (E13, E14)", () => {
  it("E12: a suspension carries suspended", async () => {
    const result = await runRuntime({
      llm: queuedLLM([
        toolCall(
          "suspend",
          {
            reason: "Need a name",
            fields: [{ type: "text", name: "answer", label: "Answer" }],
          },
          "tc-suspend",
        ),
      ]),
      manifest: manifest({ tools: { builtin: ["suspend"] } }),
      deps: {
        toolExecutor: createToolExecutor({
          findTool: (name) => (name === "suspend" ? suspendTool : undefined),
          getToolSource: () => "builtin",
        }),
      },
    });
    expect(result.status).toBe("suspended");
    expect(result.stop).toEqual({ reason: "suspended" });
  });

  it("E13: a schema-gate failure is invalid-output", async () => {
    const result = await runRuntime({
      llm: queuedLLM([prose(JSON.stringify({ count: "many" }))]),
      deps: {
        loadRuntime: async (runtime) => ({
          manifest: runtime,
          promptTemplate: "Count.",
          outputSchema: {
            type: "object",
            properties: { count: { type: "number" } },
            required: ["count"],
          },
        }),
      },
    });
    expect(result.status).toBe("failed");
    expect(result.stop).toEqual({ reason: "invalid-output" });
  });

  it("E14: a requireToolUse miss keeps the loop's own completed", async () => {
    const result = await runRuntime({
      llm: queuedLLM([prose("I did it."), prose("Really, I did.")]),
      manifest: manifest({ requireToolUse: true }),
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("requireToolUse");
    expect(result.stop).toEqual({ reason: "completed" });
  });
});

describe("stop through finalization", () => {
  function failedResult(stop?: RuntimeResult["stop"]): RuntimeResult {
    return {
      pluginId: "plug",
      runtimeId: "plug/loop",
      runId: "run",
      turnId: "turn",
      status: "failed",
      output: null,
      error: "boom",
      toolCalls: [],
      durationMs: 1,
      timestamp: new Date().toISOString(),
      ...(stop ? { stop } : {}),
    };
  }

  it("a PostRuntime hook that rewrites the result cannot change stop", async () => {
    const pipeline = createHookPipeline();
    pipeline.register({
      id: "rewrite",
      event: "PostRuntime",
      handler: async (_ctx, payload) => {
        const { result } = payload as { result: RuntimeResult };
        return {
          action: "continue",
          replace: {
            result: {
              ...result,
              error: "rewritten",
              stop: { reason: "completed" },
            },
          },
        };
      },
    });
    const rewritten = await runPostRuntimeHook(
      {
        pipeline,
        sessionId: "s",
        turnId: "turn",
        pluginId: "plug",
        runtimeId: "plug/loop",
      },
      failedResult({ reason: "max-steps" }),
    );
    expect(rewritten.error).toBe("rewritten");
    expect(rewritten.stop).toEqual({ reason: "max-steps" });
  });

  it("a failure a PostRuntime hook turns into success keeps no stale max-steps", async () => {
    const hookPipeline = createHookPipeline();
    hookPipeline.register({
      id: "recover",
      event: "PostRuntime",
      handler: async (_ctx, payload) => {
        const { result } = payload as { result: RuntimeResult };
        return {
          action: "continue",
          replace: {
            result: {
              ...result,
              status: "success",
              output: { recovered: true },
            },
          },
        };
      },
    });
    let n = 0;
    const result = await runRuntime({
      llm: scriptedLLM((params) =>
        params.tools
          ? toolCall("mark", { note: `n${n}` }, `tc-${n++}`, "scratch")
          : prose(""),
      ),
      manifest: manifest({ maxSteps: 1 }),
      deps: { hookPipeline },
    });
    expect(result.status).toBe("success");
    expect(result.stop).toBeUndefined();
  });

  it("a thrown exit keeps its stop through finalizeThrownRuntime, unless a hook recovers it", async () => {
    const failing = scriptedLLM(() => {
      throw new Error("PROVIDER_ERROR: upstream exploded");
    });
    const hookPipeline = createHookPipeline();
    hookPipeline.register({
      id: "recover",
      event: "PostRuntime",
      handler: async (_ctx, payload) => {
        const { result } = payload as { result: RuntimeResult };
        return {
          action: "continue",
          replace: {
            result: { ...result, status: "success", output: { ok: true } },
          },
        };
      },
    });
    const recovered = await runRuntime({
      llm: failing,
      deps: { hookPipeline },
    });
    expect(recovered.status).toBe("success");
    expect(recovered.stop).toBeUndefined();
  });
});
