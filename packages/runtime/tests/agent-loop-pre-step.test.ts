/**
 * The `PreStep` hook: what it sees, how it narrows a step's tools, changes
 * the tool choice, lowers the steps left or ends the loop, and what it cannot
 * do (grant a tool, stop a finalizer, act as a guard).
 */

import { describe, expect, it, vi } from "vitest";
import type { LLMToolDefinition, RuntimeManifest } from "@covel/shared";
import { createMemoryStore } from "@covel/store/memory";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import type { HookContext } from "../src/hooks/types.js";
import type {
  PreLLMCallRequest,
  PreStepPayload,
} from "../src/hooks/wire-helpers.js";
import { resumeRuntimePipeline } from "../src/turn-executor/turn-executor.js";
import { makeEmitterSpy } from "./_helpers/emitter-spy.js";
import {
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
  type GenerateParams,
} from "./_helpers/agent-loop-fixture.js";

const twoTools = manifest({ tools: { plugin: ["mark", "save"] } });
const twoToolExecutor = () => makeExecutor([markTool, saveTool]);

const toolNamesOf = (request: GenerateParams | undefined) =>
  (request?.tools ?? []).map((definition) => definition.name);

/** A pipeline whose PreStep handler is `handler`; records each payload. */
function preStepPipeline(
  handler: (payload: PreStepPayload, ctx: HookContext) => unknown,
  options: { timeoutMs?: number } = {},
) {
  const pipeline = createHookPipeline();
  const seen: { payload: PreStepPayload; ctx: HookContext }[] = [];
  pipeline.register<PreStepPayload>({
    id: "pre-step",
    event: "PreStep",
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    handler: async (ctx, payload) => {
      seen.push({ payload, ctx });
      return ((await handler(payload, ctx)) ?? {
        action: "continue",
      }) as never;
    },
  });
  return { pipeline, seen };
}

describe("PreStep", () => {
  it("sees the step, the steps left, the limit, the tools and the tool choice", async () => {
    const { pipeline, seen } = preStepPipeline(() => undefined);
    await runLoop({
      llm: queuedLLM([toolCall("mark", { note: "a" }), prose("done")]),
      manifest: twoTools,
      deps: { toolExecutor: twoToolExecutor() },
      hookPipeline: pipeline,
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]?.payload).toMatchObject({
      step: 1,
      stepsRemaining: 5,
      maxSteps: 5,
      toolChoice: "auto",
    });
    expect(seen[0]?.payload.toolNames).toEqual(
      expect.arrayContaining(["mark", "save"]),
    );
    expect(seen[1]?.payload).toMatchObject({ step: 2, stepsRemaining: 4 });
    expect(seen[0]?.ctx).toMatchObject({
      event: "PreStep",
      pluginId: "plug",
      runtimeId: "plug/loop",
    });
  });

  it("narrows one step's tools, ignores unknown names, and grants nothing", async () => {
    const { pipeline } = preStepPipeline((payload) =>
      payload.step === 1
        ? { action: "continue", replace: { tools: ["save", "ghost"] } }
        : undefined,
    );
    const emitter = makeEmitterSpy();
    // The model calls `mark` although the hook took it away for step 1.
    const llm = queuedLLM([toolCall("mark", { note: "a" }), prose("done")]);
    const result = await runLoop({
      llm,
      manifest: twoTools,
      deps: { toolExecutor: twoToolExecutor(), emitter },
      hookPipeline: pipeline,
    });
    expect(toolNamesOf(llm.requests[0])).toEqual(["save"]);
    expect(toolNamesOf(llm.requests[1])).toEqual(
      expect.arrayContaining(["mark", "save"]),
    );
    // Execution stays bound by the manifest: the removed tool still runs.
    expect(result.collectedToolCalls.map((call) => call.toolName)).toEqual([
      "mark",
    ]);
    expect(result.executedToolCalls[0]?.success).toBe(true);
    const completed = emitter.events.find(
      (event) => event.type === "step.completed",
    );
    expect(completed?.payload.notes).toEqual([
      { kind: "tool-narrowed", count: 1, ignored: 1 },
    ]);
    const started = emitter.events.find(
      (event) => event.type === "step.started",
    );
    expect(started?.payload.toolCount).toBe(1);
  });

  it("sends its tool choice, clears a manifest choice with auto, and never overrides a correction", async () => {
    // `required` reaches the adapter.
    const required = preStepPipeline(() => ({
      action: "continue",
      replace: { toolChoice: "required" },
    }));
    const llm = queuedLLM([toolCall("mark", { note: "a" }), prose("done")]);
    await runLoop({ llm, hookPipeline: required.pipeline });
    expect(llm.requests[0]?.defaults?.toolChoice).toBe("required");

    // `auto` clears the manifest's `required` for the step.
    const auto = preStepPipeline(() => ({
      action: "continue",
      replace: { toolChoice: "auto" },
    }));
    const forced = queuedLLM([prose("done")]);
    await runLoop({
      llm: forced,
      manifest: manifest({ llm: { toolChoice: "required" } }),
      hookPipeline: auto.pipeline,
    });
    expect(auto.seen[0]?.payload.toolChoice).toBe("required");
    expect(forced.requests[0]?.defaults?.toolChoice).toBeUndefined();

    // A correction asked for a tool call: `auto` does not lift it.
    const corrected = preStepPipeline(() => ({
      action: "continue",
      replace: { toolChoice: "auto" },
    }));
    const correcting = queuedLLM([
      prose("nothing to do"),
      toolCall("mark", { note: "a" }),
    ]);
    await runLoop({
      llm: correcting,
      manifest: manifest({
        requireToolUse: true,
        completeAfterTools: ["mark"],
      }),
      hookPipeline: corrected.pipeline,
    });
    expect(corrected.seen[1]?.payload.toolChoice).toBe("required");
    expect(correcting.requests[1]?.defaults?.toolChoice).toBe("required");

    // A named choice outside the step's tools is dropped.
    const named = preStepPipeline(() => ({
      action: "continue",
      replace: { tools: ["save"], toolChoice: { name: "mark" } },
    }));
    const namedLLM = queuedLLM([prose("done")]);
    await runLoop({
      llm: namedLLM,
      manifest: twoTools,
      deps: { toolExecutor: twoToolExecutor() },
      hookPipeline: named.pipeline,
    });
    expect(namedLLM.requests[0]?.defaults?.toolChoice).toBeUndefined();
  });

  it("lowers the steps left, and ignores a raise", async () => {
    let n = 0;
    const busy = () =>
      scriptedLLM((params) =>
        params.tools
          ? toolCall("mark", { note: `n${n}` }, `tc-${n++}`)
          : prose(""),
      );
    const lower = preStepPipeline((payload) =>
      payload.step === 1
        ? { action: "continue", replace: { stepsRemaining: 2 } }
        : undefined,
    );
    const lowered = busy();
    const result = await runLoop({
      llm: lowered,
      hookPipeline: lower.pipeline,
      maxSteps: 5,
    });
    expect(result.stop.reason).toBe("max-steps");
    expect(result.effectiveMaxSteps).toBe(5);
    expect(lower.seen.map((entry) => entry.payload.maxSteps)).toEqual([5, 2]);
    expect(lowered.requests.filter((request) => request.tools)).toHaveLength(2);

    const raise = preStepPipeline(() => ({
      action: "continue",
      replace: { stepsRemaining: 50 },
    }));
    const raised = busy();
    await runLoop({ llm: raised, hookPipeline: raise.pipeline, maxSteps: 3 });
    expect(raised.requests.filter((request) => request.tools)).toHaveLength(3);
    expect(raise.seen.map((entry) => entry.payload.maxSteps)).toEqual([
      3, 3, 3,
    ]);
  });

  it("ends the loop as tool-finished before any model call, and settle still judges the contract", async () => {
    const stop = () =>
      preStepPipeline(() => ({
        action: "continue",
        replace: { stop: { reason: "tool-finished" } },
      }));
    const llm = queuedLLM([prose("never")]);
    const finished = await runRuntime({
      llm,
      deps: { hookPipeline: stop().pipeline },
    });
    expect(llm.requests).toHaveLength(0);
    expect(finished.stop).toEqual({ reason: "tool-finished" });
    expect(finished.status).toBe("success");

    const contract = await runRuntime({
      llm,
      manifest: manifest({ requireToolUse: true }),
      deps: { hookPipeline: stop().pipeline },
    });
    expect(contract.status).toBe("failed");
    expect(contract.error).toContain("requireToolUse");
    expect(contract.stop).toEqual({ reason: "tool-finished" });
  });

  it("cancels the loop as a failure that keeps its tool calls", async () => {
    const { pipeline } = preStepPipeline((payload) =>
      payload.step === 2
        ? {
            action: "continue",
            replace: {
              stop: { reason: "cancelled", message: "budget exceeded" },
            },
          }
        : undefined,
    );
    const result = await runRuntime({
      llm: queuedLLM([toolCall("mark", { note: "a" }), prose("never")]),
      deps: { hookPipeline: pipeline },
    });
    expect(result.status).toBe("failed");
    expect(result.error).toBe(
      'Runtime "plug/loop" was stopped by a PreStep hook: budget exceeded',
    );
    expect(result.stop).toEqual({ reason: "cancelled", cancelledBy: "hook" });
    expect(result.toolCalls.map((call) => call.toolName)).toEqual(["mark"]);
  });

  it("drops a stop with a reason a hook may not use", async () => {
    const { pipeline } = preStepPipeline(() => ({
      action: "continue",
      replace: { stop: { reason: "completed" }, stepsRemaining: 0 },
    }));
    const result = await runLoop({
      llm: queuedLLM([prose("done")]),
      hookPipeline: pipeline,
    });
    expect(result.stop).toEqual({ reason: "completed" });
    expect(result.finalContent).toBe("done");
  });

  it("skips a handler that throws or times out, and reads abort as no change", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const handlers: [string, () => unknown, number?][] = [
        [
          "throws",
          () => {
            throw new Error("handler bug");
          },
        ],
        ["times out", () => new Promise(() => {}), 20],
        ["aborts", () => ({ action: "abort", reason: "no" })],
      ];
      for (const [label, handler, timeoutMs] of handlers) {
        const { pipeline } = preStepPipeline(
          handler,
          timeoutMs ? { timeoutMs } : {},
        );
        const llm = queuedLLM([toolCall("mark", { note: "a" }), prose("done")]);
        const result = await runLoop({
          llm,
          manifest: twoTools,
          deps: { toolExecutor: twoToolExecutor() },
          hookPipeline: pipeline,
        });
        expect(result.stop, label).toEqual({ reason: "completed" });
        expect(toolNamesOf(llm.requests[0]), label).toEqual(
          expect.arrayContaining(["mark", "save"]),
        );
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("runs before PreLLMCall, whose tools replacement wins for the request", async () => {
    const { pipeline } = preStepPipeline(() => ({
      action: "continue",
      replace: { tools: ["save"] },
    }));
    const markDefinition: LLMToolDefinition = {
      name: "mark",
      description: "records a marker",
      parameters: { type: "object" },
    };
    const preLLMTools: string[][] = [];
    const order: string[] = [];
    pipeline.register<PreLLMCallRequest>({
      id: "pre-llm",
      event: "PreLLMCall",
      handler: async (_ctx, request) => {
        order.push("PreLLMCall");
        preLLMTools.push((request.tools ?? []).map((tool) => tool.name));
        return { action: "continue", replace: { tools: [markDefinition] } };
      },
    });
    pipeline.register<PreStepPayload>({
      id: "order",
      event: "PreStep",
      handler: async () => {
        order.push("PreStep");
        return { action: "continue" };
      },
    });
    const llm = queuedLLM([prose("done")]);
    await runLoop({
      llm,
      manifest: twoTools,
      deps: { toolExecutor: twoToolExecutor() },
      hookPipeline: pipeline,
    });
    expect(order).toEqual(["PreStep", "PreLLMCall"]);
    expect(preLLMTools).toEqual([["save"]]);
    expect(toolNamesOf(llm.requests[0])).toEqual(["mark"]);
  });

  it("does not run for the finalizer step", async () => {
    const { pipeline, seen } = preStepPipeline(() => undefined);
    let n = 0;
    const llm = scriptedLLM((params) =>
      params.tools
        ? toolCall("mark", { note: `n${n}` }, `tc-${n++}`, "scratch")
        : prose("final"),
    );
    const result = await runLoop({ llm, hookPipeline: pipeline, maxSteps: 2 });
    expect(result.stop).toEqual({ reason: "max-steps", finalizer: true });
    expect(llm.requests).toHaveLength(3);
    expect(seen.map((entry) => entry.payload.step)).toEqual([1, 2]);
  });

  it("runs on every step of a resumed loop", async () => {
    const { pipeline, seen } = preStepPipeline(() => undefined);
    const runtime: RuntimeManifest = {
      ...manifest(),
      trigger: { type: "manual" },
    };
    const result = await resumeRuntimePipeline(
      {
        id: "suspension",
        sessionId: input.sessionId,
        turnId: input.turnId,
        runtimeId: runtime.name,
        pluginId: runtime.pluginId,
        reason: "wait",
        resumeSchema: {},
        createdAt: new Date().toISOString(),
        pendingContinuation: {
          takenUnder: { playerTurns: 0, pluginVersion: "1.0.0", writes: [] },
          executionContext: {
            executionId: "prior-run",
            origin: "manual",
            countPolicy: "none",
          },
          messages: [],
          toolCallsSoFar: [],
          pendingProposals: [],
        },
      },
      {},
      runtime,
      {
        store: createMemoryStore(),
        hookPipeline: pipeline,
        llm: queuedLLM([toolCall("mark", { note: "a" }), prose("done")]),
        toolExecutor: makeExecutor(),
        loadRuntime: async () => ({
          manifest: runtime,
          promptTemplate: "Do the work.",
        }),
      },
    );
    expect(result.status).toBe("success");
    expect(seen.map((entry) => entry.payload.step)).toEqual([1, 2]);
  });
});
