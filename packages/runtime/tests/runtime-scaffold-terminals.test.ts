/**
 * Characterization of the execution scaffold shared by function handlers,
 * agent guards, the dispatcher and resume (`runtime-scaffold.ts`): event
 * placement, hook and terminal counts, exact failure strings, timeout
 * precedence and the suspension terminal. These pin today's behaviour so the
 * scaffold stays an internal refactor.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "@covel/events";
import type {
  HandlerResult,
  LLMMessage,
  RuntimeManifest,
  RuntimeResult,
  SubscriptionEvent,
} from "@covel/shared";
import type {
  FunctionHandlerContext,
  LoadedRuntime,
} from "@covel/shared/plugin-runtime";
import type { SuspensionRecord } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import { runTurnPipeline } from "../src/turn-executor/turn-executor.js";
import { resumeRuntimePipeline } from "../src/resume/turn-resume.js";
import { executeAgentGuard } from "../src/agent-loop/turn-agent-guard.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor-types.js";
import type { TurnEmitter } from "../src/trace/turn-emitter.js";
import {
  collectExecutionSuspensionRuns,
  collectExecutionSuspensions,
} from "../src/suspension-artifact.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const SESSION = "session";
const TURN = "turn";
const input = {
  origin: "player" as const,
  sessionId: SESSION,
  turnId: TURN,
  playerMessage: "Continue",
};

function manifest(extra: Partial<RuntimeManifest> = {}): RuntimeManifest {
  return {
    name: "probe/main",
    pluginId: "probe",
    description: "probe",
    stage: "narrative",
    outputKind: "system",
    trigger: { type: "auto" },
    maxRetries: 0,
    ...extra,
  } as RuntimeManifest;
}

const stop = (content: string) => ({
  content,
  toolCalls: [],
  finishReason: "stop" as const,
  usage: { inputTokens: 1, outputTokens: 1 },
});

const suspendCall = (id = "call-suspend") => ({
  content: null,
  toolCalls: [{ id, name: "suspend", arguments: "{}" }],
  finishReason: "tool_calls" as const,
  usage: { inputTokens: 1, outputTokens: 1 },
});

const sentinel = { _covelSuspend: true, reason: "input", resumeSchema: {} };

function toolExecutor(results: Record<string, unknown> = {}) {
  return {
    getToolInfo: (name: string) => ({
      name,
      description: name,
      annotations: {
        readOnly: false,
        stagesWrites: true,
        idempotent: false,
        concurrencySafe: false,
      },
      jsonSchema: { type: "object" as const, properties: {} },
    }),
    async execute(call: {
      readonly toolCallId: string;
      readonly name: string;
    }) {
      const parsed = results[call.name] ?? { ok: true };
      return {
        toolCallId: call.toolCallId,
        name: call.name,
        result: JSON.stringify(parsed),
        parsedResult: parsed,
        success: true,
      };
    },
  };
}

/** One timeline for bus events, trace events and hook calls. */
function harness(extra: Partial<TurnExecutorDeps> = {}) {
  const timeline: string[] = [];
  const posted: RuntimeResult[] = [];
  const eventBus = createEventBus();
  const busEvents: SubscriptionEvent[] = [];
  eventBus.onEmit((event) => {
    busEvents.push(event);
    timeline.push(event.type);
  });
  const traceEvents: { type: string; payload: unknown }[] = [];
  const emitter = {
    sessionId: SESSION,
    turnId: TURN,
    async emit(type: string, payload: unknown) {
      traceEvents.push({ type, payload });
      timeline.push(type);
    },
  } as unknown as TurnEmitter;
  const hookPipeline = createHookPipeline();
  hookPipeline.register({
    id: "observe-post",
    event: "PostRuntime",
    async handler(_context, payload) {
      const { result } = payload as { result: RuntimeResult };
      posted.push(structuredClone(result));
      timeline.push("PostRuntime");
      return { action: "continue" };
    },
  });
  const onRuntimeComplete = vi.fn(async () => {});
  const deps = (loaded: Partial<LoadedRuntime>): TurnExecutorDeps => ({
    eventBus,
    emitter,
    hookPipeline,
    onRuntimeComplete,
    llm: { generate: vi.fn(async () => stop("{}")) },
    loadRuntime: async (runtime) => ({
      manifest: runtime,
      promptTemplate: "probe",
      ...loaded,
    }),
    ...extra,
  });
  const count = (type: string) =>
    timeline.filter((entry) => entry === type).length;
  /** Runtime lifecycle, function trace and PostRuntime entries, in order. */
  const lifecycle = () =>
    timeline.filter((type) =>
      /^(runtime\.|function\.|PostRuntime$)/.test(type),
    );
  return {
    timeline,
    posted,
    busEvents,
    traceEvents,
    hookPipeline,
    onRuntimeComplete,
    deps,
    count,
    lifecycle,
    close: () => eventBus.close(),
  };
}

describe("guard terminals", () => {
  it.each(["throw", "timeout"] as const)(
    "a guard %s finalizes once with no runtime.started and no function events",
    async (kind) => {
      const h = harness();
      const release = Promise.withResolvers<void>();
      const runtime = manifest({ runtimeType: "agent", timeoutMs: 30 });
      try {
        const turn = await runTurnPipeline(
          input,
          [runtime],
          h.deps({
            guard: async () => {
              if (kind === "throw") throw new Error("guard broke");
              await release.promise;
              return { skip: true };
            },
          }),
        );
        expect(turn.runtimeResults[0]).toMatchObject({
          status: "failed",
          output: null,
          error:
            kind === "throw"
              ? "guard broke"
              : 'agent guard "probe/main" timed out after 30ms',
        });
        expect(h.count("PostRuntime")).toBe(1);
        expect(h.count("runtime.failed")).toBe(1);
        expect(h.count("runtime.started")).toBe(0);
        expect(
          h.timeline.filter((type) => type.startsWith("function.")),
        ).toEqual([]);
      } finally {
        release.resolve();
        await h.close();
      }
    },
  );

  it("cancels an aborted guard without PostRuntime or runtime.started", async () => {
    const h = harness();
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const runtime = manifest({ runtimeType: "agent" });
    try {
      const running = runTurnPipeline(input, [runtime], {
        ...h.deps({
          guard: async () => {
            entered.resolve();
            await release.promise;
            return { skip: true };
          },
        }),
        turnControl: { executionSignal: controller.signal },
      });
      await entered.promise;
      controller.abort("stop");
      const turn = await running;
      // The guard's own abort text never surfaces: PostRuntime does not run
      // under a cancelled turn, and finalization reports the cancellation.
      expect(h.posted).toEqual([]);
      expect(turn.runtimeResults[0]).toMatchObject({
        status: "failed",
        error: "Runtime execution was cancelled",
      });
      expect(h.count("runtime.started")).toBe(0);
    } finally {
      release.resolve();
      await h.close();
    }
  });

  it("a guard skip emits no runtime.started; a guard pass starts the agent once", async () => {
    for (const skip of [true, false]) {
      const h = harness();
      try {
        const turn = await runTurnPipeline(
          input,
          [manifest({ runtimeType: "agent" })],
          h.deps({ guard: async () => ({ skip }) }),
        );
        expect(turn.runtimeResults[0]?.status).toBe(
          skip ? "skipped" : "success",
        );
        expect(h.count("runtime.started")).toBe(skip ? 0 : 1);
        expect(h.count("PostRuntime")).toBe(1);
      } finally {
        await h.close();
      }
    }
  });

  it("revokes a guard's capabilities after a normal completion", async () => {
    const store = createMemoryStore();
    const h = harness({ store });
    let captured: FunctionHandlerContext | undefined;
    try {
      const turn = await runTurnPipeline(
        input,
        [manifest({ runtimeType: "agent" })],
        h.deps({
          guard: async (ctx) => {
            captured = ctx;
            return { skip: false };
          },
        }),
      );
      expect(turn.runtimeResults[0]?.status).toBe("success");
      expect(captured?.signal?.aborted).toBe(true);
      expect(captured?.signal?.reason).toEqual(
        new Error('agent guard "probe/main" completed'),
      );
      expect(() => captured!.pluginData!.set("notes", "late", "value")).toThrow(
        /revoked/,
      );
    } finally {
      await h.close();
    }
  });
});

describe("guard lease", () => {
  it("rejects a cancelled guard with its own abort text for a non-Error reason", async () => {
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const runtime = manifest({ runtimeType: "agent" });
    const executionContext = {
      executionId: "exec",
      origin: "player" as const,
      countPolicy: "none" as const,
    };
    try {
      const running = executeAgentGuard({
        manifest: runtime,
        input,
        loaded: {
          manifest: runtime,
          promptTemplate: "probe",
          guard: async () => {
            entered.resolve();
            await release.promise;
            return { skip: true };
          },
        },
        deps: {
          loadRuntime: async () => undefined,
          llm: { generate: vi.fn(async () => stop("{}")) },
          turnControl: { executionSignal: controller.signal },
        },
        hookPipeline: undefined,
        triggerEvent: undefined,
        executionContext,
        createRecursiveCall: () => async () => {
          throw new Error("not used");
        },
        recursionDepth: 0,
        startTime: Date.now(),
        runId: "run",
        timeoutMs: 5_000,
      });
      await entered.promise;
      controller.abort("stop");
      await expect(running).rejects.toThrow(
        new Error('agent guard "probe/main" aborted'),
      );
    } finally {
      release.resolve();
    }
  });

  it("revokes a synchronously throwing guard before a microtask it queued runs", async () => {
    const h = harness({ store: createMemoryStore() });
    const probe: { error?: string; wrote?: boolean } = {};
    const probed = Promise.withResolvers<void>();
    try {
      const turn = await runTurnPipeline(
        input,
        [manifest({ runtimeType: "agent" })],
        h.deps({
          guard: (ctx) => {
            queueMicrotask(() => {
              void (async () => {
                try {
                  await ctx.pluginData!.set("notes", "late", "value");
                  probe.wrote = true;
                } catch (err) {
                  probe.error =
                    err instanceof Error ? err.message : String(err);
                } finally {
                  probed.resolve();
                }
              })();
            });
            throw new Error("guard broke");
          },
        }),
      );
      await probed.promise;
      expect(turn.runtimeResults[0]).toMatchObject({
        status: "failed",
        error: "guard broke",
      });
      expect(probe.wrote).toBeUndefined();
      expect(probe.error).toContain('"pluginData.set" is revoked');
    } finally {
      await h.close();
    }
  });
});

describe("function terminals", () => {
  it("emits runtime.started once before function.executing, then one PostRuntime and terminal", async () => {
    const h = harness();
    try {
      const turn = await runTurnPipeline(
        input,
        [manifest({ runtimeType: "function" })],
        h.deps({
          handler: async () => ({ outcome: "success", value: { n: 1 } }),
        }),
      );
      expect(turn.runtimeResults[0]?.status).toBe("success");
      expect(h.lifecycle()).toEqual([
        "runtime.started",
        "function.executing",
        "function.completed",
        "PostRuntime",
        "runtime.completed",
      ]);
    } finally {
      await h.close();
    }
  });

  it("finalizes a missing handler once without runtime.started", async () => {
    const h = harness();
    try {
      const turn = await runTurnPipeline(
        input,
        [manifest({ runtimeType: "function" })],
        h.deps({}),
      );
      expect(turn.runtimeResults[0]).toMatchObject({
        status: "failed",
        error: "Function runtime missing handler",
      });
      // The start event precedes the handler check.
      expect(h.lifecycle()).toEqual([
        "runtime.started",
        "PostRuntime",
        "runtime.failed",
      ]);
    } finally {
      await h.close();
    }
  });

  it("reports the function timeout text and one failed terminal", async () => {
    const h = harness();
    const release = Promise.withResolvers<void>();
    try {
      const turn = await runTurnPipeline(
        input,
        [manifest({ runtimeType: "function", timeoutMs: 30 })],
        h.deps({
          handler: async () => {
            await release.promise;
            return { outcome: "success", value: {} };
          },
        }),
      );
      const error = 'function runtime "probe/main" timed out after 30ms';
      expect(turn.runtimeResults[0]).toMatchObject({ status: "failed", error });
      expect(
        h.traceEvents.filter((event) => event.type === "function.completed"),
      ).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({ status: "failed", error }),
        }),
      ]);
      expect(h.lifecycle()).toEqual([
        "runtime.started",
        "function.executing",
        "function.completed",
        "PostRuntime",
        "runtime.failed",
      ]);
    } finally {
      release.resolve();
      await h.close();
    }
  });

  it("reports the function abort text on function.completed when the turn aborts with a non-Error reason", async () => {
    const h = harness();
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let captured: FunctionHandlerContext | undefined;
    try {
      const running = runTurnPipeline(
        input,
        [manifest({ runtimeType: "function" })],
        {
          ...h.deps({
            handler: async (ctx) => {
              captured = ctx;
              entered.resolve();
              await release.promise;
              return { outcome: "success", value: {} };
            },
          }),
          turnControl: { executionSignal: controller.signal },
        },
      );
      await entered.promise;
      controller.abort("stop");
      const turn = await running;
      const error = 'function runtime "probe/main" was aborted';
      expect(h.posted).toEqual([]);
      expect(turn.runtimeResults[0]).toMatchObject({
        status: "failed",
        error: "Runtime execution was cancelled",
      });
      expect(
        h.traceEvents.find((event) => event.type === "function.completed"),
      ).toMatchObject({ payload: { status: "failed", error } });
      expect(captured?.signal?.reason).toBe("stop");
    } finally {
      release.resolve();
      await h.close();
    }
  });

  it("aborts a completed handler's signal with the completion text", async () => {
    const h = harness();
    let captured: FunctionHandlerContext | undefined;
    try {
      await runTurnPipeline(
        input,
        [manifest({ runtimeType: "function" })],
        h.deps({
          handler: async (ctx) => {
            captured = ctx;
            return { outcome: "success", value: {} };
          },
        }),
      );
      expect(captured?.signal?.reason).toEqual(
        new Error('function runtime "probe/main" completed'),
      );
    } finally {
      await h.close();
    }
  });

  it("finalizes a thrown handler error once through the dispatcher", async () => {
    const h = harness();
    try {
      const turn = await runTurnPipeline(
        input,
        [manifest({ runtimeType: "function" })],
        h.deps({
          handler: async () => {
            throw new Error("handler broke");
          },
        }),
      );
      expect(turn.runtimeResults[0]).toMatchObject({
        status: "failed",
        output: null,
        error: "handler broke",
      });
      expect(h.lifecycle()).toEqual([
        "runtime.started",
        "function.executing",
        "function.completed",
        "PostRuntime",
        "runtime.failed",
      ]);
    } finally {
      await h.close();
    }
  });

  it("finalizes a runtime the loader cannot find once", async () => {
    const h = harness();
    try {
      const turn = await runTurnPipeline(
        input,
        [manifest({ runtimeType: "function" })],
        { ...h.deps({}), loadRuntime: async () => undefined },
      );
      expect(turn.runtimeResults[0]).toMatchObject({
        status: "failed",
        error: "Runtime not found",
      });
      expect(h.lifecycle()).toEqual(["PostRuntime", "runtime.failed"]);
    } finally {
      await h.close();
    }
  });
});

describe("suspension terminal", () => {
  const takenUnder = expect.objectContaining({ playerTurns: 0 });

  it("keeps toolCalls empty on a function suspension and snapshots its continuation", async () => {
    const h = harness({ toolExecutor: toolExecutor() });
    const runtime = manifest({
      runtimeType: "function",
      tools: { builtin: ["probe-tool"] },
    });
    try {
      const turn = await runTurnPipeline(
        input,
        [runtime],
        h.deps({
          handler: async (ctx) => {
            await ctx.tools!.call("probe-tool", {});
            return {
              outcome: "suspended",
              reason: "input",
              resumeSchema: { type: "object" },
            } as HandlerResult;
          },
        }),
      );
      const result = turn.runtimeResults[0]!;
      const [record] = collectExecutionSuspensions(turn);
      expect(result).toMatchObject({
        status: "suspended",
        toolCalls: [],
        output: {
          suspended: true,
          suspensionId: record!.id,
          reason: "input",
          resumeSchema: { type: "object" },
        },
      });
      expect(Object.keys(result)).toEqual([
        "pluginId",
        "runtimeId",
        "runId",
        "turnId",
        "status",
        "output",
        "toolCalls",
        "durationMs",
        "timestamp",
      ]);
      expect(record).toEqual({
        id: expect.any(String),
        sessionId: SESSION,
        turnId: TURN,
        runtimeId: runtime.name,
        pluginId: runtime.pluginId,
        reason: "input",
        resumeSchema: { type: "object" },
        pendingContinuation: {
          messages: [],
          toolCallsSoFar: [],
          pendingProposals: [],
          inputSlots: {},
          exportSlots: {},
          activation: { source: "stage", detached: false, payload: null },
          emittedEvents: [],
          executionContext: expect.objectContaining({ origin: "player" }),
          takenUnder,
          logicalTurn: 1,
        },
        createdAt: expect.any(String),
      });
      expect(Object.keys(record!.pendingContinuation)).toEqual([
        "messages",
        "toolCallsSoFar",
        "pendingProposals",
        "inputSlots",
        "exportSlots",
        "activation",
        "emittedEvents",
        "executionContext",
        "takenUnder",
        "logicalTurn",
      ]);
      expect(collectExecutionSuspensionRuns(turn)).toEqual({
        [record!.id]: result.runId,
      });
      // PostRuntime waits for the end of the logical runtime.
      expect(h.count("PostRuntime")).toBe(0);
      expect(h.count("runtime.completed")).toBe(1);
    } finally {
      await h.close();
    }
  });

  it("snapshots an agent suspension continuation and maps it to its run", async () => {
    const h = harness({ toolExecutor: toolExecutor({ suspend: sentinel }) });
    const runtime = manifest({
      runtimeType: "agent",
      tools: { builtin: ["suspend"] },
    });
    try {
      const turn = await runTurnPipeline(input, [runtime], {
        ...h.deps({}),
        llm: { generate: vi.fn(async () => suspendCall()) },
      });
      const result = turn.runtimeResults[0]!;
      const [record] = collectExecutionSuspensions(turn);
      expect(result).toMatchObject({
        status: "suspended",
        output: {
          suspended: true,
          suspensionId: record!.id,
          reason: "input",
          resumeSchema: {},
        },
      });
      expect(result.toolCalls).toEqual([]);
      expect(record).toEqual({
        id: expect.any(String),
        sessionId: SESSION,
        turnId: TURN,
        runtimeId: runtime.name,
        pluginId: runtime.pluginId,
        reason: "input",
        resumeSchema: {},
        pendingContinuation: {
          messages: [
            { role: "system", content: expect.any(String) },
            { role: "user", content: "Continue" },
            {
              role: "assistant",
              content: "",
              toolCalls: [
                { id: "call-suspend", name: "suspend", arguments: "{}" },
              ],
            },
            {
              role: "tool",
              content: JSON.stringify({ suspended: true }),
              toolCallId: "call-suspend",
            },
          ],
          toolCallsSoFar: [],
          completionCalls: [],
          pendingProposals: [],
          inputSlots: {},
          executionContext: expect.objectContaining({ origin: "player" }),
          takenUnder,
          logicalTurn: 1,
          turnNumber: 0,
          currentTurnUserMessages: 1,
          suspendToolCallId: "call-suspend",
        },
        createdAt: expect.any(String),
      });
      // `partialContent` is present as undefined when the model sent none.
      expect(Object.keys(record!.pendingContinuation)).toEqual([
        "messages",
        "partialContent",
        "toolCallsSoFar",
        "completionCalls",
        "pendingProposals",
        "inputSlots",
        "executionContext",
        "takenUnder",
        "logicalTurn",
        "turnNumber",
        "currentTurnUserMessages",
        "suspendToolCallId",
      ]);
      expect(collectExecutionSuspensionRuns(turn)).toEqual({
        [record!.id]: result.runId,
      });
      // PostRuntime waits for the end of the logical runtime.
      expect(h.count("PostRuntime")).toBe(0);
      expect(h.count("runtime.completed")).toBe(1);
    } finally {
      await h.close();
    }
  });

  it("maps a function and an agent suspension of one turn to their own runs", async () => {
    const h = harness({ toolExecutor: toolExecutor({ suspend: sentinel }) });
    const fn = manifest({ name: "probe/fn", runtimeType: "function" });
    const agent = manifest({
      name: "probe/agent",
      runtimeType: "agent",
      tools: { builtin: ["suspend"] },
    });
    try {
      const turn = await runTurnPipeline(input, [fn, agent], {
        ...h.deps({
          handler: async () =>
            ({ outcome: "suspended", reason: "fn" }) as HandlerResult,
        }),
        llm: { generate: vi.fn(async () => suspendCall()) },
      });
      const records = collectExecutionSuspensions(turn);
      const runs = collectExecutionSuspensionRuns(turn);
      expect(records).toHaveLength(2);
      for (const record of records) {
        const owner = turn.runtimeResults.find(
          (result) => result.runtimeId === record.runtimeId,
        );
        expect(owner?.status).toBe("suspended");
        expect(runs[record.id]).toBe(owner?.runId);
      }
      expect(new Set(Object.values(runs)).size).toBe(2);
    } finally {
      await h.close();
    }
  });
});

describe("resume terminals", () => {
  function suspension(
    runtime: RuntimeManifest,
    continuation: Partial<SuspensionRecord["pendingContinuation"]> = {},
  ): SuspensionRecord {
    return {
      id: "suspension",
      sessionId: SESSION,
      turnId: TURN,
      pluginId: runtime.pluginId,
      runtimeId: runtime.name,
      reason: "input",
      resumeSchema: {},
      createdAt: new Date().toISOString(),
      pendingContinuation: {
        takenUnder: { playerTurns: 0, pluginVersion: "1.0.0", writes: [] },
        executionContext: {
          executionId: "previous-run",
          origin: "manual",
          countPolicy: "none",
        },
        messages: [],
        toolCallsSoFar: [],
        pendingProposals: [],
        ...continuation,
      },
    };
  }

  it("lets a resumed function suspend again with a new continuation", async () => {
    const h = harness();
    const runtime = manifest({ runtimeType: "function" });
    try {
      const result = await resumeRuntimePipeline(
        suspension(runtime),
        {},
        runtime,
        h.deps({
          handler: async () =>
            ({ outcome: "suspended", reason: "again" }) as HandlerResult,
        }),
      );
      expect(result.status).toBe("suspended");
      const [record] = collectExecutionSuspensions({
        runtimeResults: [result],
      });
      expect(record).toMatchObject({
        reason: "again",
        runtimeId: runtime.name,
      });
      expect(record!.id).not.toBe("suspension");
      expect(result.output).toMatchObject({ suspensionId: record!.id });
      expect(h.count("PostRuntime")).toBe(0);
      expect(
        h.busEvents.find((event) => event.type === "runtime.started")?.payload,
      ).toMatchObject({ resumed: true });
      expect(h.count("runtime.completed")).toBe(1);
    } finally {
      await h.close();
    }
  });

  it("lets a resumed agent suspend again with its whole transcript", async () => {
    const h = harness({ toolExecutor: toolExecutor({ suspend: sentinel }) });
    const runtime = manifest({
      runtimeType: "agent",
      tools: { builtin: ["suspend"] },
    });
    const generate = vi.fn().mockResolvedValueOnce(suspendCall("call-again"));
    const previous: LLMMessage[] = [
      { role: "system", content: "probe" },
      { role: "user", content: "Continue" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-first", name: "suspend", arguments: "{}" }],
      },
      {
        role: "tool",
        content: JSON.stringify({ suspended: true }),
        toolCallId: "call-first",
      },
    ];
    try {
      const result = await resumeRuntimePipeline(
        suspension(runtime, {
          messages: previous,
          suspendToolCallId: "call-first",
        }),
        { answer: 1 },
        runtime,
        { ...h.deps({}), llm: { generate } },
      );
      expect(result.status).toBe("suspended");
      expect(generate).toHaveBeenCalledTimes(1);
      const [record] = collectExecutionSuspensions({
        runtimeResults: [result],
      });
      expect(record!.pendingContinuation).toMatchObject({
        suspendToolCallId: "call-again",
        messages: [
          ...previous.slice(0, 3),
          {
            role: "tool",
            content: JSON.stringify({ resumeData: { answer: 1 } }),
            toolCallId: "call-first",
          },
          {
            role: "assistant",
            toolCalls: [{ id: "call-again", name: "suspend", arguments: "{}" }],
          },
          {
            role: "tool",
            content: JSON.stringify({ suspended: true }),
            toolCallId: "call-again",
          },
        ],
      });
      expect(h.count("PostRuntime")).toBe(0);
    } finally {
      await h.close();
    }
  });

  it("lets manifest.timeoutMs beat options.timeoutMs on resume, as on dispatch", async () => {
    const h = harness();
    const release = Promise.withResolvers<void>();
    const runtime = manifest({ runtimeType: "function", timeoutMs: 30 });
    try {
      const result = await resumeRuntimePipeline(
        suspension(runtime),
        {},
        runtime,
        h.deps({
          handler: async () => {
            await release.promise;
            return { outcome: "success", value: {} };
          },
        }),
        { timeoutMs: 60_000 },
      );
      expect(result).toMatchObject({
        status: "failed",
        error: 'function runtime "probe/main" timed out after 30ms',
      });
    } finally {
      release.resolve();
      await h.close();
    }
  });

  it("finalizes a thrown resume failure with plain deps, once", async () => {
    const h = harness();
    const runtime = manifest({ runtimeType: "agent" });
    try {
      const result = await resumeRuntimePipeline(
        suspension(runtime),
        {},
        runtime,
        {
          ...h.deps({}),
          llm: {
            generate: vi.fn(async () => {
              throw new Error("resume broke");
            }),
          },
        },
      );
      expect(result).toMatchObject({
        status: "failed",
        output: null,
        error: expect.stringContaining("resume broke"),
      });
      expect(h.count("PostRuntime")).toBe(1);
      expect(h.count("runtime.failed")).toBe(1);
    } finally {
      await h.close();
    }
  });

  it("finalizes 'Runtime not found on resume' once with the PostRuntime options of the agent path", async () => {
    const h = harness();
    // A hook recovers the failure. Recovery reloads the output schema only
    // because no schema key is passed, and skips the contract reload because
    // the `outputContractSchema` key is present (as undefined).
    h.hookPipeline.register({
      id: "recover-missing",
      event: "PostRuntime",
      async handler(_context, payload) {
        const { result } = payload as { result: RuntimeResult };
        return {
          action: "continue",
          replace: {
            result: { ...result, status: "success", output: { ok: true } },
          },
        };
      },
    });
    const runtime = manifest({
      runtimeType: "agent",
      outputContract: "probe-output@1",
    });
    const loadRuntime = vi.fn(async () => undefined);
    try {
      const result = await resumeRuntimePipeline(
        suspension(runtime),
        {},
        runtime,
        { ...h.deps({}), loadRuntime },
      );
      expect(h.posted).toEqual([
        expect.objectContaining({
          status: "failed",
          error: "Runtime not found on resume",
        }),
      ]);
      expect(h.posted[0]).not.toHaveProperty("failureTarget");
      expect(result).toMatchObject({ status: "success", output: { ok: true } });
      expect(result).not.toHaveProperty("failureTarget");
      expect(loadRuntime).toHaveBeenCalledTimes(2);
      expect(h.count("runtime.completed")).toBe(1);
    } finally {
      await h.close();
    }
  });
});

describe("agent timeout", () => {
  it("fails a thrown agent timeout without a failure target, even with the target known", async () => {
    let reachedTool = false;
    const h = harness({
      toolExecutor: {
        ...toolExecutor(),
        execute: (_call: unknown, ctx: { signal?: AbortSignal }) =>
          new Promise((_, reject) => {
            reachedTool = true;
            ctx.signal?.addEventListener("abort", () =>
              reject(ctx.signal?.reason),
            );
          }),
      } as unknown as TurnExecutorDeps["toolExecutor"],
    });
    const runtime = manifest({
      runtimeType: "agent",
      timeoutMs: 30,
      tools: { builtin: ["probe-tool"] },
    });
    const target = { provider: "probe-provider", model: "probe-model" };
    const resolveTarget = vi.fn(() => target);
    const generate = vi.fn(async () => ({
      content: null,
      toolCalls: [{ id: "call", name: "probe-tool", arguments: "{}" }],
      finishReason: "tool_calls" as const,
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    try {
      const turn = await runTurnPipeline(input, [runtime], {
        ...h.deps({}),
        llm: { generate, resolveTarget },
      });
      // The model call returned with a resolved target and the loop reached
      // the tool stage, so the agent knew its target when the deadline hit.
      expect(resolveTarget).toHaveBeenCalled();
      expect(generate).toHaveBeenCalledTimes(1);
      expect(reachedTool).toBe(true);
      const result = turn.runtimeResults[0]!;
      expect(result).toMatchObject({
        status: "failed",
        output: null,
        error: 'agent runtime "probe/main" timed out after 30ms',
      });
      expect(result.error).not.toContain("[provider:");
      expect(result).not.toHaveProperty("failureTarget");
      expect(h.count("PostRuntime")).toBe(1);
      expect(h.count("runtime.failed")).toBe(1);
    } finally {
      await h.close();
    }
  });
});
