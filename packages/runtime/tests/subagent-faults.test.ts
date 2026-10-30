import { afterEach, describe, expect, it, vi } from "vitest";
import { AiProviderError } from "@covel/ai-provider";
import { createMemoryStore } from "@covel/store/memory";
import type { DataStore } from "@covel/store";
import type {
  LLMAdapter,
  LLMResponse,
  RuntimeManifest,
  SubagentErrorCode,
  SubagentResult,
  TurnInput,
} from "@covel/shared";
import type {
  FunctionHandler,
  LoadedRuntime,
} from "@covel/shared/plugin-runtime";
import { delegateTool, suspendTool, ToolRegistry } from "@covel/tools";
import {
  createSubagentRunner,
  SUBAGENT_POOL_PER_EXECUTION,
  type SubagentRunArgs,
  type SubagentSettledEvent,
} from "../src/agent-loop/subagent-runner.js";
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";
import { createExecutionContext } from "../src/turn-executor/execution-context.js";
import {
  commitExecution,
  executeTurn,
  resumeSuspendedRuntime,
  type ExecutionDeps,
} from "../src/index.js";
import { createPluginFaultLatch } from "../src/faults/plugin-fault-latch.js";
import { makeEmitterSpy } from "./_helpers/emitter-spy.js";

const CONTRACT = "test-actor@1";
const input: TurnInput = {
  sessionId: "s",
  turnId: "turn",
  playerMessage: "Open the gate",
  origin: "player",
  locale: "en-US",
};
const schema = {
  type: "object",
  properties: { line: { type: "string" } },
  required: ["line"],
  additionalProperties: false,
};
const provider: RuntimeManifest = {
  pluginId: "actor-pkg",
  name: "actor-pkg/guard",
  description: "guard",
  runtimeType: "agent",
  outputKind: "system",
  subagentOnly: true,
  trigger: { type: "manual" },
  outputContract: CONTRACT,
  output: { schema: "output.schema.json" },
  maxRetries: 0,
};
const caller: RuntimeManifest = {
  pluginId: "caller-pkg",
  name: "caller-pkg/main",
  description: "caller",
  runtimeType: "function",
  stage: "narrative",
  trigger: { type: "auto" },
};
const request = {
  target: { contract: CONTRACT },
  brief: "Challenge the stranger.",
};
const committed = {
  status: "committed" as const,
  events: [],
  failedProposals: [],
};
const open: DataStore[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(open.splice(0).map((store) => store.close()));
});

function json(value: unknown): LLMResponse {
  return {
    content: JSON.stringify(value),
    toolCalls: [],
    finishReason: "stop",
    usage: { inputTokens: 7, outputTokens: 3 },
  };
}
function call(name: string, args: object, id = name): LLMResponse {
  return {
    content: null,
    toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
    finishReason: "tool_calls",
    usage: { inputTokens: 7, outputTokens: 3 },
  };
}
function hang(
  params: Parameters<LLMAdapter["generate"]>[0],
): Promise<LLMResponse> {
  return new Promise((_, reject) => {
    const signal = params.signal;
    const abort = () => reject(signal?.reason ?? new Error("aborted"));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}
async function seeded() {
  const store = createMemoryStore();
  open.push(store);
  const now = new Date().toISOString();
  await store.createSession({
    id: "s",
    locale: "en-US",
    status: "active",
    phase: "playing",
    setupRuntimes: {},
    seats: [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
    activePlugins: [caller.pluginId, provider.pluginId],
    completedPlayerTurns: 0,
    createdAt: now,
    updatedAt: now,
  });
  return store;
}
function fixture(
  options: {
    provider?: RuntimeManifest;
    reply?: LLMAdapter["generate"];
    loaded?: (manifest: RuntimeManifest) => LoadedRuntime | undefined;
    handler?: FunctionHandler;
  } = {},
) {
  const actor = options.provider ?? provider;
  const registry = new ToolRegistry();
  registry.registerBuiltin(delegateTool);
  registry.registerBuiltin(suspendTool);
  const generate = vi.fn<LLMAdapter["generate"]>(
    options.reply ?? (async () => json({ line: "Halt!" })),
  );
  const loadRuntime = vi.fn(
    async (manifest: RuntimeManifest): Promise<LoadedRuntime | undefined> => {
      if (options.loaded) return options.loaded(manifest);
      return {
        manifest,
        promptTemplate: manifest.name,
        ...(manifest.runtimeType === "function"
          ? { handler: options.handler }
          : { outputSchema: schema, outputContractSchema: schema }),
      };
    },
  );
  const emitter = makeEmitterSpy();
  const deps = {
    llm: { generate },
    loadRuntime,
    emitter,
    toolExecutor: createToolExecutor({
      findTool: (name, context) => registry.find(name, context.pluginId),
      getToolSource: (name) => registry.source(name),
    }),
  };
  const onSettled = vi.fn<(event: SubagentSettledEvent) => void>();
  const runner = createSubagentRunner({ activeRuntimes: [actor], onSettled });
  const args: SubagentRunArgs = {
    caller: { pluginId: caller.pluginId, runtimeId: caller.name, depth: 0 },
    request,
    input,
    deps,
    executionContext: createExecutionContext(input),
    parentCallId: "call",
  };
  return {
    actor,
    deps,
    emitter,
    generate,
    loadRuntime,
    onSettled,
    runner,
    args,
  };
}

describe("sub-agent provider attribution", () => {
  it.each<{
    name: string;
    code: SubagentErrorCode;
    fault?: "runtime" | "timeout";
    provider?: Partial<RuntimeManifest>;
    reply?: LLMAdapter["generate"];
    budget?: { timeoutMs: number };
    missing?: boolean;
    contractInvalid?: boolean;
  }>([
    {
      name: "prose instead of schema output",
      code: "internal",
      fault: "runtime",
      reply: async () => ({ ...json({}), content: "Halt!" }),
    },
    {
      name: "contract output invalid",
      code: "internal",
      fault: "runtime",
      contractInvalid: true,
    },
    {
      name: "step limit exhausted",
      code: "internal",
      fault: "runtime",
      provider: { maxSteps: 1 },
      reply: async () => call("unknown", {}),
    },
    {
      name: "model provider error",
      code: "internal",
      reply: async () => {
        throw new AiProviderError({
          provider: "remote",
          code: "PROVIDER_ERROR",
          message: "network failed",
          retriable: false,
        });
      },
    },
    {
      name: "provider deadline",
      code: "timeout",
      fault: "timeout",
      provider: { timeoutMs: 40 },
      reply: hang,
    },
    {
      name: "request deadline",
      code: "timeout",
      budget: { timeoutMs: 40 },
      reply: hang,
    },
    {
      name: "provider wins a request deadline tie",
      code: "timeout",
      fault: "timeout",
      provider: { timeoutMs: 40 },
      budget: { timeoutMs: 40 },
      reply: hang,
    },
    {
      name: "unregistered declared tool",
      code: "internal",
      fault: "runtime",
      provider: { tools: { plugin: ["missing"] } },
    },
    { name: "runtime not loaded", code: "internal", missing: true },
  ])("$name", async (test) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = fixture({
      provider: { ...provider, ...test.provider },
      reply: test.reply,
      ...(test.missing ? { loaded: () => undefined } : {}),
      ...(test.contractInvalid
        ? {
            loaded: (manifest: RuntimeManifest) => ({
              manifest,
              promptTemplate: manifest.name,
              outputSchema: { type: "object" },
              outputContractSchema: schema,
            }),
            reply: async () => json({ wrong: true }),
          }
        : {}),
    });
    const result = await f.runner.run({
      ...f.args,
      request: { ...request, ...(test.budget ? { budget: test.budget } : {}) },
    });
    expect(result).toMatchObject({ ok: false, error: { code: test.code } });
    expect(result).not.toHaveProperty("fault");
    expect(f.onSettled).toHaveBeenCalledTimes(1);
    const [event] = f.onSettled.mock.calls[0] ?? [];
    expect(event).toMatchObject({
      pluginId: provider.pluginId,
      runtimeId: provider.name,
      callerPluginId: caller.pluginId,
      callerRuntimeId: caller.name,
      ok: false,
      code: test.code,
    });
    expect(event?.fault).toBe(test.fault);
    const failure = f.emitter.events.find(
      (event) => event.type === "subagent.failed",
    );
    expect(failure?.payload.fault).toBe(test.fault);
    if (test.provider?.tools || test.missing)
      expect(f.generate).not.toHaveBeenCalled();
    if (test.name === "prose instead of schema output")
      expect(f.generate).toHaveBeenCalledTimes(2);
  });

  it("keeps a function caller's tighter remaining deadline neutral", async () => {
    const store = await seeded();
    const onSettled = vi.fn<(event: SubagentSettledEvent) => void>();
    let answer: SubagentResult | undefined;
    const f = fixture({
      reply: hang,
      handler: async (ctx) => {
        if (!ctx.agents) throw new Error("sub-agent context missing");
        answer = await ctx.agents.run(request);
        return { outcome: "success", value: {} };
      },
    });
    const runner = createSubagentRunner({
      activeRuntimes: [provider],
      onSettled,
    });
    await executeTurn(input, [{ ...caller, timeoutMs: 80 }, provider], {
      ...f.deps,
      store,
      subagents: runner,
    });
    expect(answer?.ok).toBe(false);
    if (!answer || answer.ok) throw new Error("sub-agent failure missing");
    // The parent's timer can abort the child before its local deadline fires.
    expect(["timeout", "cancelled"]).toContain(answer.error.code);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled.mock.calls[0]?.[0].fault).toBeUndefined();
  });

  it.each(["caller", "execution", "player"] as const)(
    "keeps %s cancellation neutral",
    async (source) => {
      const controller = new AbortController();
      const f = fixture({
        reply: async (params) => {
          controller.abort(new Error("cancelled"));
          return hang(params);
        },
      });
      const result = await f.runner.run({
        ...f.args,
        ...(source === "caller"
          ? { parentSignal: controller.signal }
          : {
              deps: {
                ...f.deps,
                turnControl:
                  source === "player"
                    ? { signal: controller.signal }
                    : { executionSignal: controller.signal },
              },
            }),
      });
      expect(result).toMatchObject({ ok: false, error: { code: "cancelled" } });
      expect(f.onSettled).toHaveBeenCalledTimes(1);
      expect(f.onSettled.mock.calls[0]?.[0].fault).toBeUndefined();
    },
  );

  it("does not blame a provider when the parent's deadline already passed", async () => {
    const f = fixture();
    expect(
      await f.runner.run({ ...f.args, parentDeadline: Date.now() - 1 }),
    ).toMatchObject({ ok: false, error: { code: "timeout" } });
    expect(f.onSettled.mock.calls[0]?.[0].fault).toBeUndefined();
    expect(f.generate).not.toHaveBeenCalled();
  });

  it("returns timeout without attribution for a tighter parent deadline", async () => {
    const f = fixture({ reply: hang });
    expect(
      await f.runner.run({ ...f.args, parentDeadline: Date.now() + 40 }),
    ).toMatchObject({ ok: false, error: { code: "timeout" } });
    expect(f.onSettled.mock.calls[0]?.[0].fault).toBeUndefined();
  });
});

describe("sub-agent admission", () => {
  it.each([
    { name: "invalid input", request: {}, code: "invalid-input" },
    {
      name: "missing provider",
      request: { ...request, target: { contract: "missing@1" } },
      code: "not-found",
    },
    { name: "depth cap", depth: 1, code: "unavailable" },
    { name: "ambiguous providers", ambiguous: true, code: "ambiguous" },
  ])("does not settle a refusal: $name", async (test) => {
    const f = fixture();
    const runner = createSubagentRunner({
      activeRuntimes: test.ambiguous
        ? [provider, { ...provider, pluginId: "other", name: "other/guard" }]
        : [provider],
      onSettled: f.onSettled,
    });
    expect(
      await runner.run({
        ...f.args,
        request: test.request ?? request,
        caller: { ...f.args.caller, depth: test.depth ?? 0 },
      }),
    ).toMatchObject({ ok: false, error: { code: test.code } });
    expect(f.onSettled).not.toHaveBeenCalled();
    expect(f.loadRuntime).not.toHaveBeenCalled();
  });

  it("does not settle a pool-cap refusal", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = fixture({
      reply: async () => {
        await gate;
        return json({ line: "Halt!" });
      },
    });
    const pending = Array.from({ length: SUBAGENT_POOL_PER_EXECUTION }, () =>
      f.runner.run(f.args),
    );
    expect(await f.runner.run(f.args)).toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
    expect(f.onSettled).not.toHaveBeenCalled();
    release();
    await Promise.all(pending);
    expect(f.onSettled).toHaveBeenCalledTimes(SUBAGENT_POOL_PER_EXECUTION);
  });

  it.each(["contract", "runtimeId"] as const)(
    "refuses the paused provider addressed by %s with its identity in the trace",
    async (target) => {
      const f = fixture();
      const runner = createSubagentRunner({
        activeRuntimes: [],
        pausedRuntimes: [provider],
        onSettled: f.onSettled,
      });
      const result = await runner.run({
        ...f.args,
        caller: { ...f.args.caller, pluginId: provider.pluginId },
        request: {
          ...request,
          target:
            target === "contract"
              ? { contract: CONTRACT }
              : { runtimeId: provider.name },
        },
      });
      expect(result).toEqual({
        ok: false,
        error: {
          code: "unavailable",
          message:
            target === "contract"
              ? `The sub-agent provider for contract "${CONTRACT}" is paused in this session after repeated errors`
              : `The sub-agent runtime "${provider.name}" is paused in this session after repeated errors`,
        },
      });
      expect(f.loadRuntime).not.toHaveBeenCalled();
      expect(f.generate).not.toHaveBeenCalled();
      expect(f.onSettled).not.toHaveBeenCalled();
      expect(
        f.emitter.events.find((event) => event.type === "subagent.failed")
          ?.payload,
      ).toMatchObject({
        code: "unavailable",
        pluginId: provider.pluginId,
        runtimeId: provider.name,
      });
    },
  );

  it("counts paused providers toward contract ambiguity", async () => {
    const f = fixture();
    const runner = createSubagentRunner({
      activeRuntimes: [{ ...provider, pluginId: "other", name: "other/guard" }],
      pausedRuntimes: [provider],
      onSettled: f.onSettled,
    });
    expect(await runner.run(f.args)).toMatchObject({
      ok: false,
      error: { code: "ambiguous" },
    });
    expect(f.onSettled).not.toHaveBeenCalled();
    expect(f.loadRuntime).not.toHaveBeenCalled();
  });
});

describe("sub-agent faults at execution boundaries", () => {
  it.each([false, true])(
    "collects provider faults and deduplicates logical inputs: repeated=%s",
    async (repeated) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const store = await seeded();
      const latch = createPluginFaultLatch();
      let answer: SubagentResult | undefined;
      const f = fixture({
        provider: { ...provider, tools: { plugin: ["missing"] } },
        handler: async (ctx) => {
          if (!ctx.agents) throw new Error("sub-agent context missing");
          answer = await ctx.agents.run(request);
          return { outcome: "success", value: { ok: answer.ok } };
        },
      });
      const deps: ExecutionDeps = { ...f.deps, store, pluginFaults: latch };
      const transitions = [];
      for (const turnId of ["one", "two", "three"]) {
        const execution = await executeTurn(
          { ...input, turnId, logicalTurnId: repeated ? "same" : turnId },
          [caller, f.actor],
          deps,
        );
        expect(execution.commit.subagentRuns).toEqual([
          expect.objectContaining({
            pluginId: provider.pluginId,
            callerRuntimeId: caller.name,
            fault: "runtime",
            ok: false,
          }),
        ]);
        transitions.push(
          ...latch.recordExecution({
            sessionId: "s",
            logicalKey:
              execution.commit.executionContext.logicalTurnId ?? turnId,
            results: execution.commit.results,
            subagentRuns: execution.commit.subagentRuns,
            outcome: committed,
            exempt: new Set(),
          }),
        );
      }
      expect(latch.isLatched("s", provider.pluginId)).toBe(!repeated);
      const counted = transitions.filter(
        (event) => event.type === "plugin.fault.counted",
      );
      expect(counted).toHaveLength(repeated ? 1 : 3);
      for (const event of counted)
        expect(event.payload.pluginId).toBe(provider.pluginId);
      f.loadRuntime.mockClear();
      const fourth = await executeTurn(
        { ...input, turnId: "four" },
        [caller, f.actor],
        deps,
      );
      if (!repeated) {
        expect(answer).toMatchObject({
          ok: false,
          error: { code: "unavailable" },
        });
        expect(fourth.commit.subagentRuns).toBeUndefined();
        expect(
          f.loadRuntime.mock.calls.map(([manifest]) => manifest.name),
        ).toEqual([caller.name]);
      }
      expect(f.generate).not.toHaveBeenCalled();
    },
  );

  it("deduplicates a provider's top-level and sub-agent faults", () => {
    const latch = createPluginFaultLatch();
    const transitions = latch.recordExecution({
      sessionId: "s",
      logicalKey: "one",
      exempt: new Set(),
      outcome: committed,
      results: [
        {
          pluginId: provider.pluginId,
          runtimeId: "actor-pkg/main",
          runId: "run",
          status: "failed",
          fault: "runtime",
        },
      ],
      subagentRuns: [1, 2].map(() => ({
        pluginId: provider.pluginId,
        callerRuntimeId: caller.name,
        ok: false,
        fault: "runtime" as const,
      })),
    });
    expect(transitions).toMatchObject([
      {
        type: "plugin.fault.counted",
        payload: { pluginId: provider.pluginId, consecutiveFaults: 1 },
      },
    ]);
  });

  it("keeps provider admission frozen for the duration of an execution", async () => {
    const store = await seeded();
    const latch = createPluginFaultLatch({ threshold: 1 });
    const answers: SubagentResult[] = [];
    const f = fixture({
      handler: async (ctx) => {
        latch.recordHookFault(
          "s",
          provider.pluginId,
          "during-execution",
          "hook",
        );
        if (!ctx.agents) throw new Error("sub-agent context missing");
        answers.push(await ctx.agents.run(request));
        return { outcome: "success", value: {} };
      },
    });
    const deps = { ...f.deps, store, pluginFaults: latch };
    await executeTurn(input, [caller, provider], deps);
    await executeTurn({ ...input, turnId: "next" }, [caller, provider], deps);
    expect(answers).toMatchObject([
      { ok: true },
      { ok: false, error: { code: "unavailable" } },
    ]);
    expect(f.generate).toHaveBeenCalledTimes(1);
  });

  it("refuses delegation to a provider paused before the caller resumes", async () => {
    const store = await seeded();
    const latch = createPluginFaultLatch({ threshold: 1 });
    const director: RuntimeManifest = {
      ...caller,
      runtimeType: "agent",
      outputKind: "system",
      output: { schema: "output.schema.json" },
      tools: { builtin: ["suspend", "delegate"] },
      maxRetries: 0,
    };
    let step = 0;
    const f = fixture({
      reply: async () => {
        switch (step++) {
          case 0:
            return call("suspend", {
              reason: "Confirm",
              resumeSchema: { type: "object" },
            });
          case 1:
            return call("delegate", request);
          default:
            return json({ line: "Continue without the guard." });
        }
      },
    });
    const deps = { ...f.deps, store, pluginFaults: latch };
    const execution = await executeTurn(input, [director, provider], deps);
    expect(execution.result.runtimeResults[0]?.status).toBe("suspended");
    expect(
      (
        await commitExecution({
          store,
          execution,
          completion: { kind: "turn", turnId: input.turnId, durationMs: 0 },
        })
      ).status,
    ).toBe("committed");
    const [suspension] = await store.listSuspensions("s");
    if (!suspension) throw new Error("suspension missing");
    latch.recordHookFault("s", provider.pluginId, "before-resume", "hook");
    f.loadRuntime.mockClear();
    const resumed = await resumeSuspendedRuntime(
      suspension,
      {},
      director,
      deps,
      { activeRuntimes: [director, provider] },
    );
    expect(resumed.result.status).toBe("success");
    const delegation = resumed.result.toolCalls.find(
      (call) => call.toolName === "delegate",
    );
    expect(delegation?.output).toMatchObject({
      error: { code: "unavailable" },
    });
    expect(
      f.generate.mock.calls.every(([params]) =>
        params.messages.some(
          (message) =>
            message.role === "system" &&
            String(message.content).includes(caller.name),
        ),
      ),
    ).toBe(true);
    expect(
      f.loadRuntime.mock.calls.some(
        ([manifest]) => manifest.name === provider.name,
      ),
    ).toBe(false);
    expect(resumed.commit.subagentRuns).toBeUndefined();
  });
});
