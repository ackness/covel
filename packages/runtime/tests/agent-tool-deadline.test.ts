import { afterEach, describe, expect, it, vi } from "vitest";
import { tool, z, withPendingProposals } from "@covel/tools";
import {
  runAgentToolLoop,
  type RunAgentToolLoopOptions,
} from "../src/agent-loop/turn-agent-tool-loop.js";
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";
import {
  acquireLLMSlot,
  setLLMSlotCapForTests,
} from "../src/retry/llm-slots.js";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import { resumeSuspendedRuntime } from "../src/resume/turn-resume.js";

afterEach(() => {
  vi.useRealTimers();
  setLLMSlotCapForTests(undefined);
});

function options(
  deps: RunAgentToolLoopOptions["deps"],
): RunAgentToolLoopOptions {
  return {
    executionContext: {
      executionId: "execution",
      origin: "manual",
      countPolicy: "none",
    },
    manifest: {
      name: "probe/main",
      pluginId: "probe",
      description: "Probe",
      stage: "narrative",
      outputKind: "plugin",
      trigger: { type: "auto" },
      tools: { plugin: ["probe"] },
      completeAfterTools: ["probe"],
    },
    input: { sessionId: "session", turnId: "turn", playerMessage: "probe" },
    loaded: { promptTemplate: "probe" } as RunAgentToolLoopOptions["loaded"],
    deps,
    maxSteps: 2,
    timeoutMs: 100,
    messages: [{ role: "user", content: "probe" }],
    hookPipeline: undefined,
    startTime: Date.now(),
    runId: "run",
  };
}

describe("agent tool deadline", () => {
  it.each([
    { kind: "function", expires: true },
    { kind: "guard", expires: true },
    { kind: "function", expires: false },
  ] as const)(
    "allows PostRuntime recovery only for ordinary failures ($kind, expires: $expires)",
    async ({ kind, expires }) => {
      vi.useFakeTimers();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const opts = options({ llm: { generate: vi.fn() } });
      const manifest = {
        ...opts.manifest,
        runtimeType:
          kind === "function" ? ("function" as const) : ("agent" as const),
        timeoutMs: 100,
      };
      const callback = async () => {
        entered.resolve();
        if (!expires) throw new Error("recoverable business error");
        await release.promise;
        return {};
      };
      const hookPipeline = createHookPipeline();
      hookPipeline.register({
        id: "recover-timeout",
        event: "PostRuntime",
        async handler() {
          return {
            action: "continue",
            replace: {
              result: {
                pluginId: manifest.pluginId,
                runtimeId: manifest.name,
                turnId: opts.input.turnId,
                status: "success",
                output: { recovered: true },
                toolCalls: [],
                durationMs: 0,
                timestamp: new Date().toISOString(),
              },
            },
          };
        },
      });
      const running = executeTurn(opts.input, [manifest], {
        ...opts.deps,
        hookPipeline,
        loadRuntime: async () => ({
          manifest,
          promptTemplate: "probe",
          ...(kind === "function"
            ? { handler: callback }
            : { guard: callback }),
        }),
      });
      try {
        await entered.promise;
        await vi.advanceTimersByTimeAsync(101);
        const result = await running;
        expect(result.runtimeResults[0]).toMatchObject(
          expires
            ? { status: "failed", output: null }
            : { status: "success", output: { recovered: true } },
        );
        if (expires)
          expect(result.runtimeResults[0]!.error).toContain("timed out");
      } finally {
        release.resolve();
        await running;
      }
    },
  );

  it.each([false, true])(
    "reports an outer runtime failure after a completing tool exceeds its budget (replacement hook: %s)",
    async (replaceFailure) => {
      vi.useFakeTimers();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const module = tool({
        name: "probe",
        description: "Probe",
        parameters: z.object({}),
        async execute() {
          entered.resolve();
          await release.promise;
          return { late: true };
        },
      });
      const executor = createToolExecutor({ findTool: () => module });
      const opts = options({
        llm: {
          async generate() {
            return {
              content: "partial",
              toolCalls: [{ id: "call", name: "probe", arguments: "{}" }],
              finishReason: "tool_calls",
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          },
        },
        toolExecutor: executor,
      });
      const manifest = { ...opts.manifest, timeoutMs: 100 };
      const hookPipeline = createHookPipeline();
      if (replaceFailure)
        hookPipeline.register({
          id: "replace-failure",
          event: "PostRuntime",
          async handler() {
            return {
              action: "continue",
              replace: {
                result: {
                  pluginId: manifest.pluginId,
                  runtimeId: manifest.name,
                  turnId: opts.input.turnId,
                  status: "success",
                  output: { recovered: true },
                  toolCalls: [],
                  durationMs: 0,
                  timestamp: new Date().toISOString(),
                },
              },
            };
          },
        });
      const running = executeTurn(opts.input, [manifest], {
        ...opts.deps,
        hookPipeline,
        loadRuntime: async () => ({ manifest, promptTemplate: "probe" }),
      });
      try {
        await entered.promise;
        await vi.advanceTimersByTimeAsync(101);
        const result = await running;
        expect(result.runtimeResults).toHaveLength(1);
        expect(result.runtimeResults[0]).toMatchObject({
          status: "failed",
          output: null,
        });
        expect(result.runtimeResults[0]!.error).toContain("timed out");
        expect(result.abortReason).toBeUndefined();
      } finally {
        release.resolve();
        await running;
        await executor.close();
      }
    },
  );

  it("expires a stalled PreToolUse hook before admitting its tool", async () => {
    vi.useFakeTimers();
    const entered = Promise.withResolvers<void>();
    const pipeline = createHookPipeline();
    pipeline.register({
      id: "stalled-pre-tool",
      event: "PreToolUse",
      async handler() {
        entered.resolve();
        await new Promise(() => {});
        return { action: "continue" };
      },
    });
    const execute = vi.fn();
    const opts = options({
      llm: {
        async generate() {
          return {
            content: null,
            toolCalls: [{ id: "call", name: "probe", arguments: "{}" }],
            finishReason: "tool_calls",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      },
      toolExecutor: { execute, getToolInfo: () => undefined },
    });
    const running = runAgentToolLoop({ ...opts, hookPipeline: pipeline });
    const rejected = expect(running).rejects.toThrow("timed out");
    await entered.promise;
    await vi.advanceTimersByTimeAsync(101);
    await rejected;
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["loop", "resume"] as const)(
    "cancels a stalled completing tool without accepting its late output (%s)",
    async (path) => {
      vi.useFakeTimers();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let signal: AbortSignal | undefined;
      const module = tool({
        name: "probe",
        description: "Probe",
        parameters: z.object({}),
        async execute(_args, context) {
          signal = context.signal;
          entered.resolve();
          await release.promise;
          return withPendingProposals({ late: true }, []);
        },
      });
      const executor = createToolExecutor({ findTool: () => module });
      const opts = options({
        llm: {
          async generate() {
            return {
              content: "partial",
              toolCalls: [{ id: "call", name: "probe", arguments: "{}" }],
              finishReason: "tool_calls",
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          },
        },
        toolExecutor: executor,
      });
      const running =
        path === "loop"
          ? runAgentToolLoop(opts)
          : resumeSuspendedRuntime(
              {
                id: "suspension",
                sessionId: opts.input.sessionId,
                turnId: opts.input.turnId,
                pluginId: opts.manifest.pluginId,
                runtimeId: opts.manifest.name,
                reason: "wait",
                resumeSchema: {},
                createdAt: new Date().toISOString(),
                pendingContinuation: {
                  executionContext: opts.executionContext,
                  messages: [],
                  toolCallsSoFar: [],
                  partialContent:
                    "Persisted partial output must not become success",
                  pendingProposals: [],
                },
              },
              {},
              opts.manifest,
              {
                ...opts.deps,
                loadRuntime: async () => ({
                  manifest: opts.manifest,
                  promptTemplate: "probe",
                }),
              },
              { timeoutMs: 100 },
            );
      const settled = running.then(
        (result) => ({ result, error: undefined }),
        (error: unknown) => ({ result: undefined, error }),
      );
      try {
        await entered.promise;
        await vi.advanceTimersByTimeAsync(101);
        expect(signal?.aborted).toBe(true);
        const outcome = await settled;
        if (path === "loop") {
          expect(outcome.error).toBeInstanceOf(Error);
          expect((outcome.error as Error).message).toContain("timed out");
          expect(outcome.error).not.toMatchObject({ code: "TURN_ABORTED" });
        } else {
          expect(outcome.result).toMatchObject({
            status: "failed",
            output: null,
            error: expect.stringContaining("timed out"),
          });
        }
      } finally {
        release.resolve();
        await running.catch(() => {});
        await executor.close();
      }
    },
  );

  it("preserves the execution budget while waiting for a model slot", async () => {
    vi.useFakeTimers();
    setLLMSlotCapForTests(1);
    const holder = await acquireLLMSlot();
    const generate = vi.fn(async () => ({
      content: "done",
      toolCalls: [],
      finishReason: "stop" as const,
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    const running = runAgentToolLoop(options({ llm: { generate } }));
    let failure: unknown;
    void running.catch((error) => {
      failure = error;
    });
    try {
      await vi.advanceTimersByTimeAsync(300);
      expect(generate).not.toHaveBeenCalled();
      expect(failure).toBeUndefined();
      holder.release();
      const result = await running;
      expect(result).toMatchObject({
        finalContent: "done",
        stoppedWithResponse: true,
      });
      expect(generate).toHaveBeenCalledOnce();
    } finally {
      holder.release();
      await running.catch(() => {});
    }
  });
});
