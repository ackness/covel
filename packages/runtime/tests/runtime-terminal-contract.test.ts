import { describe, expect, it, vi } from "vitest";
import { createEventBus } from "@covel/events";
import type {
  RuntimeManifest,
  RuntimeResult,
  SubscriptionEvent,
} from "@covel/shared";
import type { TurnEmitter } from "../src/trace/turn-emitter.js";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
import { resumeSuspendedRuntime } from "../src/resume/turn-resume.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor-types.js";
import { collectExecutionSuspensions } from "../src/suspension-artifact.js";

describe.each(["agent", "function"] as const)(
  "%s suspension terminal",
  (runtimeType) => {
    it.each([false, true])(
      "only publishes a suspension if PostRuntime finishes live (cancel=%s)",
      async (cancel) => {
        const manifest: RuntimeManifest = {
          name: "probe/main",
          pluginId: "probe",
          stage: "narrative",
          outputKind: "plugin",
          trigger: { type: "auto" },
          runtimeType,
          tools: { builtin: ["suspend"] },
        };
        const sentinel = {
          _covelSuspend: true,
          reason: "input",
          resumeSchema: {},
        };
        const controller = new AbortController();
        const hookPipeline = createHookPipeline();
        const post = vi.fn(async () => {
          if (cancel) controller.abort(new Error("host closing"));
          return { action: "continue" as const };
        });
        hookPipeline.register({
          id: "suspension-policy",
          event: "PostRuntime",
          handler: post,
        });
        const onRuntimeComplete = vi.fn(async () => {});
        const eventBus = createEventBus();
        const events: SubscriptionEvent[] = [];
        eventBus.onEmit((event) => events.push(event));
        try {
          const turn = await executeTurn(
            { sessionId: "session", turnId: "turn", playerMessage: "Continue" },
            [manifest],
            {
              eventBus,
              hookPipeline,
              onRuntimeComplete,
              turnControl: { executionSignal: controller.signal },
              loadRuntime: async () => ({
                manifest,
                promptTemplate: "probe",
                handler: async () => ({
                  outcome: "suspended",
                  reason: "input",
                  resumeSchema: {},
                }),
              }),
              llm: {
                async generate() {
                  return {
                    content: null,
                    toolCalls: [
                      { id: "call", name: "suspend", arguments: "{}" },
                    ],
                    finishReason: "tool_calls",
                    usage: { inputTokens: 1, outputTokens: 1 },
                  };
                },
              },
              toolExecutor: {
                getToolInfo: () => ({
                  name: "suspend",
                  description: "wait",
                  jsonSchema: { type: "object", properties: {} },
                }),
                async execute() {
                  return {
                    toolCallId: "call",
                    name: "suspend",
                    result: JSON.stringify(sentinel),
                    parsedResult: sentinel,
                    success: true,
                  };
                },
              },
            },
          );
          const status = cancel ? "failed" : "suspended";
          expect(turn.runtimeResults[0]).toMatchObject({ status });
          expect(post).toHaveBeenCalledTimes(1);
          expect(collectExecutionSuspensions(turn)).toHaveLength(
            cancel ? 0 : 1,
          );
          expect(onRuntimeComplete).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ status }),
          );
          const terminal = events.filter(
            (event) =>
              event.type === "runtime.failed" ||
              event.type === "runtime.completed",
          );
          expect(terminal).toHaveLength(1);
          expect(terminal[0]).toMatchObject({
            type: cancel ? "runtime.failed" : "runtime.completed",
            payload: { status },
          });
        } finally {
          await eventBus.close();
        }
      },
    );
  },
);

const scenarios = [
  "success",
  "returned failure",
  "throw",
  "downgrade",
  "recover",
  "cancel in PostRuntime",
  "invalid story",
  "trace failure",
  "hook fired trace failure",
  "hook rewritten trace failure",
  "hook aborted trace failure",
  "missing runtime",
] as const;

it.each(["agent", "function", "guard"] as const)(
  "PreRuntime blocks %s before side effects",
  async (kind) => {
    const manifest: RuntimeManifest = {
      name: "probe/main",
      pluginId: "probe",
      stage: "narrative",
      outputKind: "plugin",
      trigger: { type: "auto" },
      runtimeType: kind === "function" ? "function" : "agent",
    };
    const hookPipeline = createHookPipeline();
    const pre = vi.fn(async () => ({
      action: "abort" as const,
      reason: "policy blocked",
    }));
    const post = vi.fn(async () => ({ action: "continue" as const }));
    hookPipeline.register({
      id: "block-execution",
      event: "PreRuntime",
      handler: pre,
    });
    hookPipeline.register({
      id: "observe-execution",
      event: "PostRuntime",
      handler: post,
    });
    const handler = vi.fn(async () => ({ outcome: "success", value: {} }));
    const guard = vi.fn(async () => ({ skip: true }));
    const generate = vi.fn();
    const onRuntimeComplete = vi.fn(async () => {});
    const result = await executeTurn(
      { sessionId: "session", turnId: "turn", playerMessage: "Continue" },
      [manifest],
      {
        hookPipeline,
        onRuntimeComplete,
        llm: { generate },
        loadRuntime: async () => ({
          manifest,
          promptTemplate: "probe",
          handler,
          ...(kind === "guard" ? { guard } : {}),
        }),
      },
    );
    expect(result.runtimeResults[0]?.status).toBe("skipped");
    expect(pre).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
    expect(onRuntimeComplete).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ status: "skipped" }),
    );
    expect(handler).not.toHaveBeenCalled();
    expect(guard).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  },
);

describe.each(["turn", "resume"] as const)("%s terminal contract", (entry) => {
  describe.each(["agent", "function"] as const)(
    "%s execution",
    (runtimeType) => {
      it.each(scenarios)(
        "reports the final result once: %s",
        async (scenario) => {
          const manifest: RuntimeManifest = {
            name: "probe/main",
            pluginId: "probe",
            runtimeType,
            stage: "narrative",
            outputKind: "story",
            trigger: { type: "auto" },
            timeoutMs: 1000,
            maxRetries: 0,
            ...(scenario === "returned failure" && runtimeType === "agent"
              ? { outputKind: "plugin", requireExplicitCompletion: true }
              : {}),
          };
          const controller = new AbortController();
          const events: SubscriptionEvent[] = [];
          const eventBus = createEventBus();
          eventBus.onEmit((event) => events.push(event));
          const hookPipeline = createHookPipeline();
          const postRuntime = vi.fn(
            async (_context: unknown, payload: unknown) => {
              const { result } = payload as { result: RuntimeResult };
              if (scenario === "hook aborted trace failure")
                return { action: "abort" as const, reason: "policy denied" };
              if (scenario === "hook rewritten trace failure")
                return {
                  action: "continue" as const,
                  replace: {
                    result: {
                      ...result,
                      output: { narrativeOutput: "Rewritten story" },
                    },
                  },
                };
              if (scenario === "cancel in PostRuntime")
                controller.abort(new Error("host closing"));
              if (scenario === "downgrade")
                return {
                  action: "continue" as const,
                  replace: {
                    result: {
                      ...result,
                      status: "failed",
                      output: null,
                      error: "policy rejected",
                    },
                  },
                };
              if (scenario === "recover")
                return {
                  action: "continue" as const,
                  replace: {
                    result: {
                      ...result,
                      status: "success",
                      output: { narrativeOutput: "Recovered story" },
                    },
                  },
                };
              if (scenario === "invalid story")
                return {
                  action: "continue" as const,
                  replace: {
                    result: { ...result, output: { unrelated: true } },
                  },
                };
              return { action: "continue" as const };
            },
          );
          hookPipeline.register({
            id: "terminal-policy",
            event: "PostRuntime",
            handler: postRuntime,
          });
          const onRuntimeComplete = vi.fn(async () => {});
          const emit = vi.fn<TurnEmitter["emit"]>(async () => {});
          const failingHookTrace = {
            "hook fired trace failure": "hook.fired",
            "hook rewritten trace failure": "hook.rewrote",
            "hook aborted trace failure": "hook.aborted",
          } as const;
          if (scenario in failingHookTrace)
            emit.mockImplementation(async (type) => {
              if (
                type ===
                failingHookTrace[scenario as keyof typeof failingHookTrace]
              )
                throw new Error("synthetic hook trace failure");
            });
          if (scenario === "trace failure")
            emit.mockImplementation(async (type) => {
              if (type === "message.completed")
                throw new Error("trace unavailable");
            });
          const shouldThrow = scenario === "throw" || scenario === "recover";
          const deps: TurnExecutorDeps = {
            eventBus,
            hookPipeline,
            onRuntimeComplete,
            turnControl: { executionSignal: controller.signal },
            emitter: { sessionId: "session", turnId: "turn", emit },
            llm: {
              async generate() {
                if (shouldThrow) throw new Error("synthetic failure");
                return {
                  content: "Original story",
                  toolCalls: [],
                  finishReason: "stop",
                  usage: { inputTokens: 1, outputTokens: 1 },
                };
              },
            },
            loadRuntime: async () =>
              scenario === "missing runtime"
                ? undefined
                : {
                    manifest,
                    promptTemplate: "probe",
                    handler: async () => {
                      if (shouldThrow) throw new Error("synthetic failure");
                      return scenario === "returned failure"
                        ? { outcome: "failed", error: "synthetic failure" }
                        : {
                            outcome: "success",
                            value: { narrativeOutput: "Original story" },
                          };
                    },
                  },
          };
          try {
            const result =
              entry === "turn"
                ? (
                    await executeTurn(
                      {
                        sessionId: "session",
                        turnId: "turn",
                        playerMessage: "Continue",
                      },
                      [manifest],
                      deps,
                    )
                  ).runtimeResults[0]!
                : await resumeSuspendedRuntime(
                    {
                      id: "suspension",
                      sessionId: "session",
                      turnId: "turn",
                      runtimeId: manifest.name,
                      pluginId: manifest.pluginId,
                      reason: "input",
                      resumeSchema: {},
                      createdAt: new Date().toISOString(),
                      pendingContinuation: {
                        executionContext: {
                          executionId: "previous-run",
                          origin: "manual",
                          countPolicy: "none",
                        },
                        messages: [],
                        toolCallsSoFar: [],
                        pendingProposals: [],
                      },
                    },
                    {},
                    manifest,
                    deps,
                  );
            const status =
              scenario === "success" ||
              scenario === "recover" ||
              scenario === "trace failure" ||
              scenario in failingHookTrace
                ? "success"
                : "failed";
            expect(result.status).toBe(status);
            if (scenario === "hook rewritten trace failure")
              expect(result.output).toMatchObject({
                narrativeOutput: "Rewritten story",
              });
            expect(postRuntime).toHaveBeenCalledTimes(1);
            const terminal = events.filter(
              (event) =>
                event.type === "runtime.completed" ||
                event.type === "runtime.failed",
            );
            expect(terminal).toHaveLength(1);
            expect(terminal[0]).toMatchObject({
              type:
                status === "failed" ? "runtime.failed" : "runtime.completed",
              sessionId: "session",
              payload: {
                pluginId: "probe",
                runtimeId: "probe/main",
                turnId: "turn",
                runId: result.runId,
                status,
              },
            });
            expect(onRuntimeComplete).toHaveBeenCalledExactlyOnceWith(
              expect.objectContaining({
                status,
                turnId: "turn",
                runId: result.runId,
              }),
            );
            if (scenario === "cancel in PostRuntime")
              expect(result.output).toBeNull();
            const messages = emit.mock.calls.filter(
              ([type]) => type === "message.completed",
            );
            expect(messages).toHaveLength(status === "success" ? 1 : 0);
            if (status === "success")
              expect(messages[0]![1]).toMatchObject({
                content:
                  scenario === "recover"
                    ? "Recovered story"
                    : scenario === "hook rewritten trace failure"
                      ? "Rewritten story"
                      : "Original story",
                turnId: "turn",
                runId: result.runId,
              });
          } finally {
            await eventBus.close();
          }
        },
      );
    },
  );
});
