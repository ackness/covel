import { withSubagentDelegate } from "../src/agent-loop/subagent-delegate.js";
/**
 * Sub-agents (`ctx.agents.run`, the `delegate` tool, `subagentOnly`): a
 * runtime runs another agent runtime inside its own execution. The scripted
 * model routes each request by a marker in its system prompt, so the
 * caller's and the sub-agent's requests can be told apart.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type {
  LLMAdapter,
  LLMMessage,
  LLMResponse,
  LLMToolDefinition,
  RuntimeManifest,
  SubagentResult,
  TurnInput,
} from "@covel/shared";
import type { LoadedRuntime } from "@covel/shared/plugin-runtime";
import {
  createPluginDataTools,
  delegateTool,
  tool,
  ToolRegistry,
} from "@covel/tools";
import { runTurnPipeline } from "../src/turn-executor/turn-executor.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor-types.js";
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";
import {
  createSubagentRunner,
  subagentToolNames,
  SUBAGENT_POOL_PER_EXECUTION,
} from "../src/agent-loop/subagent-runner.js";
import { selectTriggeredRuntimes } from "../src/turn-executor/scheduling.js";
import { shouldTrigger } from "../src/trigger/trigger.js";
import { createExecutionContext } from "../src/turn-executor/execution-context.js";
import { makeEmitterSpy, type EmitterSpy } from "./_helpers/emitter-spy.js";

const CONTRACT = "test-actor@1";
const ACTOR_MARK = "ACTOR-PROMPT";
const PARENT_MARK = "PARENT-PROMPT";
const LINE_SCHEMA = {
  type: "object",
  properties: { line: { type: "string" } },
  required: ["line"],
  additionalProperties: false,
} as const;

const input: TurnInput = {
  origin: "player",
  sessionId: "sess-sub",
  turnId: "turn-sub",
  playerMessage: "Open the gate",
};

afterEach(() => vi.restoreAllMocks());

// ── Fixtures ────────────────────────────────────────────────────────

function actor(
  name = "actor-pkg/guard",
  extra: Partial<RuntimeManifest> = {},
): RuntimeManifest {
  return {
    name,
    pluginId: name.split("/")[0] ?? name,
    description: name,
    runtimeType: "agent",
    outputKind: "system",
    subagentOnly: true,
    trigger: { type: "manual" },
    outputContract: CONTRACT,
    output: { schema: "output.schema.json" },
    model: "actor-slot",
    ...extra,
  };
}

type Handler = NonNullable<LoadedRuntime["handler"]>;

function caller(
  handler: Handler,
  extra: Partial<RuntimeManifest> = {},
): { manifest: RuntimeManifest; handler: Handler } {
  return {
    manifest: {
      name: "caller-pkg/main",
      pluginId: "caller-pkg",
      description: "caller",
      runtimeType: "function",
      stage: "narrative",
      trigger: { type: "auto" },
      ...extra,
    },
    handler,
  };
}

interface ModelRequest {
  readonly mark: string;
  readonly messages: readonly LLMMessage[];
  readonly tools?: readonly LLMToolDefinition[];
  readonly model?: string;
}
type Reply = (
  params: Parameters<LLMAdapter["generate"]>[0],
  index: number,
) => LLMResponse | Promise<LLMResponse>;

/** Routes each request to the reply of the marker in its system prompt. */
function routedLLM(routes: Record<string, Reply>) {
  const requests: ModelRequest[] = [];
  const counts = new Map<string, number>();
  const llm: LLMAdapter = {
    async generate(params) {
      const system = params.messages
        .filter((message) => message.role === "system")
        .map((message) => String(message.content))
        .join("\n");
      const mark = Object.keys(routes).find((key) => system.includes(key));
      if (!mark) throw new Error("unrouted model request");
      requests.push({
        mark,
        messages: params.messages,
        ...(params.tools ? { tools: params.tools } : {}),
        ...(params.model !== undefined ? { model: params.model } : {}),
      });
      const index = counts.get(mark) ?? 0;
      counts.set(mark, index + 1);
      return routes[mark]!(params, index);
    },
  };
  return { llm, requests };
}

/**
 * `routedLLM` with a `stream` that delivers each reply as text deltas and
 * tool-call events, so the loop takes its streaming path.
 */
function streamingLLM(routes: Record<string, Reply>) {
  const routed = routedLLM(routes);
  const llm: LLMAdapter = {
    generate: routed.llm.generate,
    async *stream(params) {
      const reply = await routed.llm.generate(params);
      const text = reply.content ?? "";
      const half = Math.ceil(text.length / 2);
      for (const textDelta of [text.slice(0, half), text.slice(half)])
        if (textDelta) yield { type: "text-delta", textDelta };
      for (const { id, name, arguments: args } of reply.toolCalls)
        yield { type: "tool-call", id, name, arguments: args };
      yield {
        type: "done",
        finishReason: reply.finishReason,
        ...(reply.usage ? { usage: reply.usage } : {}),
      };
    },
  };
  return { llm, requests: routed.requests };
}

function json(value: unknown): LLMResponse {
  return {
    content: JSON.stringify(value),
    toolCalls: [],
    finishReason: "stop",
    usage: { inputTokens: 7, outputTokens: 3 },
  };
}

function toolCalls(
  ...calls: { name: string; args: object; id: string }[]
): LLMResponse {
  return {
    content: null,
    toolCalls: calls.map(({ name, args, id }) => ({
      id,
      name,
      arguments: JSON.stringify(args),
    })),
    finishReason: "tool_calls",
    usage: { inputTokens: 5, outputTokens: 2 },
  };
}

/** A model call that never answers; it rejects when its signal aborts. */
function hang(params: Parameters<LLMAdapter["generate"]>[0]) {
  return new Promise<LLMResponse>((_, reject) => {
    const signal = params.signal;
    if (!signal) return;
    const fail = () =>
      reject(
        signal.reason instanceof Error ? signal.reason : new Error("aborted"),
      );
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}

const readTool = (name: string) =>
  tool({
    name,
    description: `Read ${name}`,
    annotations: { readOnly: true, concurrencySafe: true, idempotent: true },
    parameters: z.object({ key: z.string() }),
    execute: async ({ key }) => ({ value: `${name}:${key}` }),
  });
const writeTool = (name: string) =>
  tool({
    name,
    description: `Write ${name}`,
    parameters: z.object({ key: z.string() }),
    execute: async () => ({ ok: true }),
  });

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerBuiltin(delegateTool);
  for (const module of createPluginDataTools(
    {} as Parameters<typeof createPluginDataTools>[0],
  ))
    registry.registerBuiltin(module);
  registry.registerPlugin("actor-pkg", readTool("peek"));
  registry.registerPlugin("actor-pkg", writeTool("poke"));
  registry.registerPlugin("director", readTool("glance"));
  return registry;
}

function makeDeps(args: {
  llm: LLMAdapter;
  runtimes: readonly { manifest: RuntimeManifest; handler?: Handler }[];
  emitter?: EmitterSpy;
  extra?: Partial<TurnExecutorDeps>;
}): TurnExecutorDeps {
  const registry = makeRegistry();
  const loaded = new Map<string, LoadedRuntime>(
    args.runtimes.map(({ manifest, handler }) => [
      manifest.name,
      manifest.runtimeType === "function"
        ? { manifest, promptTemplate: "", ...(handler ? { handler } : {}) }
        : {
            manifest,
            promptTemplate: manifest.subagentOnly
              ? `${ACTOR_MARK} You are the gate guard. Answer in character.`
              : `${PARENT_MARK} You direct the scene.`,
            outputSchema: { ...LINE_SCHEMA },
            ...(manifest.outputContract
              ? { outputContractSchema: { ...LINE_SCHEMA } }
              : {}),
          },
    ]),
  );
  return {
    loadRuntime: async (manifest) => loaded.get(manifest.name),
    llm: args.llm,
    toolExecutor: createToolExecutor({
      findTool: (name, context) => registry.find(name, context.pluginId),
      getToolSource: (name) => registry.source(name),
    }),
    resolveModel: (manifest, override) => override ?? manifest.model,
    ...(args.emitter ? { emitter: args.emitter } : {}),
    ...args.extra,
  };
}

function eventsOf(emitter: EmitterSpy, type: string) {
  return emitter.events.filter((event) => event.type === type);
}

// ── ctx.agents.run ──────────────────────────────────────────────────

describe("ctx.agents.run", () => {
  it("runs the contract's provider with the brief only and returns its output, with no runtime result of its own", async () => {
    let answer: SubagentResult | undefined;
    const main = caller(async (ctx) => {
      answer = await ctx.agents!.run({
        target: { contract: CONTRACT },
        brief: "A stranger asks to pass.",
        data: { stranger: "Mara" },
      });
      return { outcome: "success", value: { heard: answer.ok } };
    });
    const { llm, requests } = routedLLM({
      [ACTOR_MARK]: () => json({ line: "Halt!" }),
    });
    const emitter = makeEmitterSpy();
    const result = await runTurnPipeline(
      input,
      [main.manifest, actor()],
      makeDeps({ llm, runtimes: [main, { manifest: actor() }], emitter }),
    );

    expect(answer).toEqual({
      ok: true,
      output: { line: "Halt!" },
      stopReason: "completed",
      usage: { inputTokens: 7, outputTokens: 3 },
    });
    // Only the caller ran as a scheduled runtime and only it can commit.
    expect(result.runtimeResults.map((r) => r.runtimeId)).toEqual([
      "caller-pkg/main",
    ]);
    expect(result.runtimeResults[0]?.status).toBe("success");
    expect(result.runtimeResults[0]?.pendingProposals ?? []).toEqual([]);
    expect(result.nestedRuntimeResults ?? []).toEqual([]);

    // The sub-agent's transcript: its own prompt and the brief, nothing of
    // the session or the caller.
    const [request] = requests;
    expect(request?.mark).toBe(ACTOR_MARK);
    const users = request!.messages.filter((m) => m.role === "user");
    expect(users.map((m) => m.content)).toEqual([
      'A stranger asks to pass.\n\n{"stranger":"Mara"}',
    ]);
    expect(
      request!.messages.some((m) =>
        String(m.content).includes("Open the gate"),
      ),
    ).toBe(false);

    const [started] = eventsOf(emitter, "subagent.started");
    const callerRun = eventsOf(emitter, "function.executing")[0];
    expect(started?.payload).toMatchObject({
      runtimeId: "actor-pkg/guard",
      pluginId: "actor-pkg",
      parentRuntimeId: "caller-pkg/main",
      parentPluginId: "caller-pkg",
    });
    expect(callerRun).toBeDefined();
    expect(eventsOf(emitter, "subagent.completed")).toHaveLength(1);
    // Every event of the sub-agent run carries the call tree.
    const stepEvents = eventsOf(emitter, "step.started");
    expect(stepEvents).toHaveLength(1);
    expect(stepEvents[0]?.payload).toMatchObject({
      runtimeId: "actor-pkg/guard",
      subagentCallId: started?.payload.subagentCallId,
      parentCallId: started?.payload.parentCallId,
      parentRuntimeId: "caller-pkg/main",
    });
  });

  it("refuses another package's runtimeId as not-found and two providers of a contract as ambiguous", async () => {
    const answers: SubagentResult[] = [];
    const main = caller(async (ctx) => {
      answers.push(
        await ctx.agents!.run({
          target: { runtimeId: "actor-pkg/guard" },
          brief: "x",
        }),
      );
      answers.push(
        await ctx.agents!.run({ target: { contract: CONTRACT }, brief: "x" }),
      );
      answers.push(
        await ctx.agents!.run({ target: { contract: "nobody@1" }, brief: "x" }),
      );
      // @ts-expect-error A plugin's untyped code can send any request.
      answers.push(await ctx.agents!.run({ target: {}, brief: "" }));
      return { outcome: "success", value: {} };
    });
    const second = actor("other-pkg/guard");
    const { llm, requests } = routedLLM({
      [ACTOR_MARK]: () => json({ line: "unused" }),
    });
    await runTurnPipeline(
      input,
      [main.manifest, actor(), second],
      makeDeps({
        llm,
        runtimes: [main, { manifest: actor() }, { manifest: second }],
      }),
    );
    expect(answers.map((a) => (a.ok ? "ok" : a.error.code))).toEqual([
      "not-found",
      "ambiguous",
      "not-found",
      "invalid-input",
    ]);
    expect(requests).toHaveLength(0);
  });

  it("offers the sub-agent only read-only tools and refuses a write tool its model calls anyway", async () => {
    const provider = actor(undefined, {
      tools: {
        builtin: ["plugin-data-set", "plugin-data-get", "suspend"],
        plugin: ["peek", "poke"],
      },
    });
    let answer: SubagentResult | undefined;
    const main = caller(async (ctx) => {
      answer = await ctx.agents!.run({
        target: { contract: CONTRACT },
        brief: "Note the stranger.",
      });
      return { outcome: "success", value: {} };
    });
    const { llm, requests } = routedLLM({
      [ACTOR_MARK]: (_params, index) =>
        index === 0
          ? toolCalls({ name: "poke", args: { key: "k" }, id: "tc-poke" })
          : json({ line: "Noted." }),
    });
    const emitter = makeEmitterSpy();
    const result = await runTurnPipeline(
      input,
      [main.manifest, provider],
      makeDeps({ llm, runtimes: [main, { manifest: provider }], emitter }),
    );

    expect(requests[0]?.tools?.map((t) => t.name).sort()).toEqual([
      "peek",
      "plugin-data-get",
    ]);
    const refusal = eventsOf(emitter, "tool.failed").find(
      (e) => e.payload.toolName === "poke",
    );
    expect(refusal?.payload).toMatchObject({
      code: "unavailable",
      runtimeId: "actor-pkg/guard",
    });
    expect(answer).toMatchObject({ ok: true, output: { line: "Noted." } });
    expect(result.runtimeResults[0]?.pendingProposals ?? []).toEqual([]);
    expect(eventsOf(emitter, "subagent.writes-dropped")).toEqual([]);
  });

  it("fails a provider whose declared plugin tool is not registered as internal", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const provider = actor(undefined, { tools: { plugin: ["missing"] } });
    let answer: SubagentResult | undefined;
    const main = caller(async (ctx) => {
      answer = await ctx.agents!.run({
        target: { contract: CONTRACT },
        brief: "x",
      });
      return { outcome: "success", value: {} };
    });
    const { llm, requests } = routedLLM({
      [ACTOR_MARK]: () => json({ line: "never" }),
    });
    await runTurnPipeline(
      input,
      [main.manifest, provider],
      makeDeps({ llm, runtimes: [main, { manifest: provider }] }),
    );
    expect(answer).toMatchObject({ ok: false, error: { code: "internal" } });
    expect(requests).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledWith(
      "[subagent] run failed",
      expect.objectContaining({
        error:
          'runtime "actor-pkg/guard" declares plugin tool "missing", but its plugin did not register it',
      }),
    );
  });

  it(`refuses call ${SUBAGENT_POOL_PER_EXECUTION + 1} at once while ${SUBAGENT_POOL_PER_EXECUTION} run`, async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let refusedWhileBusy: SubagentResult | undefined;
    let all: SubagentResult[] = [];
    const main = caller(async (ctx) => {
      const calls = Array.from(
        { length: SUBAGENT_POOL_PER_EXECUTION + 1 },
        (_, i) =>
          ctx.agents!.run({ target: { contract: CONTRACT }, brief: `${i}` }),
      );
      refusedWhileBusy = await calls[SUBAGENT_POOL_PER_EXECUTION];
      release();
      all = await Promise.all(calls);
      return { outcome: "success", value: {} };
    });
    const { llm, requests } = routedLLM({
      [ACTOR_MARK]: async () => {
        await gate;
        return json({ line: "ok" });
      },
    });
    await runTurnPipeline(
      input,
      [main.manifest, actor()],
      makeDeps({ llm, runtimes: [main, { manifest: actor() }] }),
    );
    expect(refusedWhileBusy).toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
    expect(all.filter((a) => a.ok)).toHaveLength(SUBAGENT_POOL_PER_EXECUTION);
    expect(requests).toHaveLength(SUBAGENT_POOL_PER_EXECUTION);
  });

  it("cancels a running sub-agent with its parent and records cancelledBy parent", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const parent = new AbortController();
    let answer: SubagentResult | undefined;
    const main = caller(async (ctx) => {
      answer = await ctx.agents!.run({
        target: { contract: CONTRACT },
        brief: "Wait.",
      });
      return { outcome: "success", value: {} };
    });
    const { llm } = routedLLM({
      [ACTOR_MARK]: (params) => {
        setTimeout(() => parent.abort(new Error("parent stopped")), 5);
        return hang(params);
      },
    });
    const emitter = makeEmitterSpy();
    await runTurnPipeline(
      input,
      [main.manifest, actor()],
      makeDeps({
        llm,
        runtimes: [main, { manifest: actor() }],
        emitter,
        extra: { turnControl: { executionSignal: parent.signal } },
      }),
    );
    expect(answer).toEqual({
      ok: false,
      error: {
        code: "cancelled",
        message: "The sub-agent was cancelled with its caller",
      },
      stopReason: "cancelled",
    });
    expect(eventsOf(emitter, "subagent.failed")[0]?.payload).toMatchObject({
      code: "cancelled",
      stopReason: "cancelled",
      cancelledBy: "parent",
    });
  });

  it("drains a sub-agent the handler did not await before the runtime settles", async () => {
    let answer: SubagentResult | undefined;
    const main = caller(async (ctx) => {
      void ctx
        .agents!.run({ target: { contract: CONTRACT }, brief: "Later." })
        .then((result) => {
          answer = result;
        });
      return { outcome: "success", value: {} };
    });
    const { llm } = routedLLM({
      [ACTOR_MARK]: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return json({ line: "Done." });
      },
    });
    const result = await runTurnPipeline(
      input,
      [main.manifest, actor()],
      makeDeps({ llm, runtimes: [main, { manifest: actor() }] }),
    );
    expect(result.runtimeResults[0]?.status).toBe("success");
    expect(answer).toMatchObject({ ok: true, output: { line: "Done." } });
  });

  it("ends a sub-agent at its own deadline as timeout", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let answer: SubagentResult | undefined;
    const main = caller(async (ctx) => {
      answer = await ctx.agents!.run({
        target: { contract: CONTRACT },
        brief: "Think long.",
        budget: { timeoutMs: 40 },
      });
      return { outcome: "success", value: {} };
    });
    const { llm } = routedLLM({ [ACTOR_MARK]: (params) => hang(params) });
    const result = await runTurnPipeline(
      input,
      [main.manifest, actor()],
      makeDeps({ llm, runtimes: [main, { manifest: actor() }] }),
    );
    expect(answer).toMatchObject({
      ok: false,
      error: { code: "timeout" },
      stopReason: "deadline",
    });
    expect(result.runtimeResults[0]?.status).toBe("success");
  });

  it("runs the actor preset unless the provider names a profile", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const run = async (provider: RuntimeManifest) => {
      let answer: SubagentResult | undefined;
      const main = caller(async (ctx) => {
        answer = await ctx.agents!.run({
          target: { contract: CONTRACT },
          brief: "x",
        });
        return { outcome: "success", value: {} };
      });
      let i = 0;
      // The model repeats the same read until the loop takes its tools away.
      const { llm } = routedLLM({
        [ACTOR_MARK]: (params) =>
          params.tools
            ? toolCalls({ name: "peek", args: { key: "same" }, id: `t${i++}` })
            : json({ line: "Fine, pass." }),
      });
      await runTurnPipeline(
        input,
        [main.manifest, provider],
        makeDeps({ llm, runtimes: [main, { manifest: provider }] }),
      );
      return answer;
    };
    const tools = { plugin: ["peek"] };
    expect(await run(actor(undefined, { tools }))).toMatchObject({
      ok: true,
      output: { line: "Fine, pass." },
    });
    expect(
      await run(actor(undefined, { tools, loopProfile: { preset: "system" } })),
    ).toMatchObject({ ok: false, error: { code: "internal" } });
  });

  it("resolves the provider's own model slot and the session override keyed by its runtimeId", async () => {
    const run = async (overrides: Partial<TurnInput>) => {
      const main = caller(async (ctx) => {
        await ctx.agents!.run({ target: { contract: CONTRACT }, brief: "x" });
        return { outcome: "success", value: {} };
      });
      const { llm, requests } = routedLLM({
        [ACTOR_MARK]: () => json({ line: "ok" }),
      });
      await runTurnPipeline(
        { ...input, ...overrides },
        [main.manifest, actor()],
        makeDeps({ llm, runtimes: [main, { manifest: actor() }] }),
      );
      return requests[0]?.model;
    };
    expect(await run({})).toBe("actor-slot");
    expect(
      await run({
        modelOverride: "story-override",
        runtimeModelOverrides: { "caller-pkg/main": "caller-slot" },
      }),
    ).toBe("actor-slot");
    expect(
      await run({
        runtimeModelOverrides: { "actor-pkg/guard": "session-slot" },
      }),
    ).toBe("session-slot");
  });
});

// ── delegate ────────────────────────────────────────────────────────

function director(tools: RuntimeManifest["tools"]): RuntimeManifest {
  return {
    name: "director/lead",
    pluginId: "director",
    description: "director",
    runtimeType: "agent",
    outputKind: "system",
    stage: "narrative",
    trigger: { type: "auto" },
    output: { schema: "output.schema.json" },
    tools,
  };
}

describe("delegate", () => {
  it("runs a sub-agent for a declaring agent, traced like an ordinary tool call", async () => {
    const lead = director({ builtin: ["delegate"], plugin: ["glance"] });
    const provider = actor(undefined, { tools: { builtin: ["delegate"] } });
    const { llm, requests } = routedLLM({
      [PARENT_MARK]: (_params, index) =>
        index === 0
          ? toolCalls(
              {
                name: "delegate",
                args: {
                  target: { contract: CONTRACT },
                  brief: "Challenge the stranger.",
                },
                id: "tc-delegate",
              },
              { name: "glance", args: { key: "gate" }, id: "tc-glance" },
            )
          : json({ line: "The guard spoke." }),
      [ACTOR_MARK]: () => json({ line: "Who goes there?" }),
    });
    const emitter = makeEmitterSpy();
    const result = await runTurnPipeline(
      input,
      [lead, provider],
      makeDeps({
        llm,
        runtimes: [{ manifest: lead }, { manifest: provider }],
        emitter,
      }),
    );

    expect(result.runtimeResults.map((r) => [r.runtimeId, r.status])).toEqual([
      ["director/lead", "success"],
    ]);
    // A sub-agent at the depth cap is not offered `delegate`.
    const actorRequest = requests.find((r) => r.mark === ACTOR_MARK);
    expect(actorRequest?.tools ?? []).toEqual([]);

    const calling = eventsOf(emitter, "tool.calling");
    const delegateCalling = calling.find(
      (e) => e.payload.toolName === "delegate",
    );
    const glanceCalling = calling.find((e) => e.payload.toolName === "glance");
    expect(delegateCalling?.payload).toMatchObject({
      runtimeId: "director/lead",
      toolCallId: "tc-delegate",
      approvalStatus: "auto-allowed",
      source: "builtin",
    });
    expect(Object.keys(delegateCalling!.payload).sort()).toEqual(
      Object.keys(glanceCalling!.payload).sort(),
    );
    const completed = eventsOf(emitter, "tool.completed");
    const delegateDone = completed.find(
      (e) => e.payload.toolName === "delegate",
    );
    const glanceDone = completed.find((e) => e.payload.toolName === "glance");
    expect(delegateDone?.payload).toMatchObject({
      approvalStatus: "auto-allowed",
      success: true,
      result: '{"data":{"line":"Who goes there?"}}',
    });
    expect(Object.keys(delegateDone!.payload).sort()).toEqual(
      Object.keys(glanceDone!.payload).sort(),
    );

    // The model reads the sub-agent's output as the tool result and goes on.
    const second = requests.filter((r) => r.mark === PARENT_MARK)[1];
    const toolResult = second?.messages.find(
      (m) => m.role === "tool" && m.toolCallId === "tc-delegate",
    );
    expect(toolResult?.content).toBe('{"data":{"line":"Who goes there?"}}');

    // The sub-agent's own events point back at the delegate call.
    const subSteps = eventsOf(emitter, "step.completed").filter(
      (e) => e.payload.runtimeId === "actor-pkg/guard",
    );
    expect(subSteps).toHaveLength(1);
    expect(subSteps[0]?.payload).toMatchObject({
      parentCallId: "tc-delegate",
      parentRuntimeId: "director/lead",
    });
    expect(eventsOf(emitter, "subagent.started")[0]?.payload).toMatchObject({
      parentCallId: "tc-delegate",
      runtimeId: "actor-pkg/guard",
    });
    expect(eventsOf(emitter, "subagent.completed")[0]?.payload).toMatchObject({
      parentCallId: "tc-delegate",
      stopReason: "completed",
    });
  });

  it("hands a completing delegate's output to the caller's output gate", async () => {
    const lead: RuntimeManifest = {
      ...director({ builtin: ["delegate"] }),
      completeAfterTools: ["delegate"],
      requireToolUse: true,
    };
    const { llm, requests } = routedLLM({
      [PARENT_MARK]: () =>
        toolCalls({
          name: "delegate",
          args: { target: { contract: CONTRACT }, brief: "Speak for me." },
          id: "tc-finish",
        }),
      [ACTOR_MARK]: () => json({ line: "Who goes there?" }),
    });
    const result = await runTurnPipeline(
      input,
      [lead, actor()],
      makeDeps({
        llm,
        runtimes: [{ manifest: lead }, { manifest: actor() }],
      }),
    );
    const [leadResult] = result.runtimeResults;
    expect(leadResult?.status).toBe("success");
    // The schema `{ line }` holds the sub-agent's output, not an envelope.
    expect(leadResult?.output).toEqual({ line: "Who goes there?" });
    expect(leadResult?.stop).toEqual({ reason: "tool-finished" });
    expect(leadResult?.toolCalls[0]?.output).toEqual({
      line: "Who goes there?",
    });
    expect(requests.filter((r) => r.mark === PARENT_MARK)).toHaveLength(1);
  });

  it("streams the caller's text to the player and none of the sub-agent's", async () => {
    // Both runtimes stream from the adapter; only the caller's profile
    // forwards deltas, and a sub-agent never does, whatever profile it names.
    const lead: RuntimeManifest = {
      ...director({ builtin: ["delegate"] }),
      loopProfile: { preset: "story" },
    };
    const run = async (provider: RuntimeManifest) => {
      const deltas: { runtimeId: string; textDelta: string }[] = [];
      const { llm, requests } = streamingLLM({
        [PARENT_MARK]: (_params, index) =>
          index === 0
            ? toolCalls({
                name: "delegate",
                args: { target: { contract: CONTRACT }, brief: "Speak." },
                id: "tc-stream",
              })
            : json({ line: "LEAD-LINE" }),
        [ACTOR_MARK]: () => json({ line: "GUARD-LINE" }),
      });
      const emitter = makeEmitterSpy();
      const result = await runTurnPipeline(
        input,
        [lead, provider],
        makeDeps({
          llm,
          runtimes: [{ manifest: lead }, { manifest: provider }],
          emitter,
          extra: {
            onDelta: async ({ runtimeId, textDelta }) => {
              deltas.push({ runtimeId, textDelta });
            },
          },
        }),
      );
      return { result, deltas, requests, emitter };
    };

    for (const provider of [
      actor(),
      actor(undefined, { loopProfile: { preset: "story" } }),
    ]) {
      const { result, deltas, requests, emitter } = await run(provider);
      expect(result.runtimeResults[0]?.output).toEqual({ line: "LEAD-LINE" });
      // The sub-agent answered through the stream path all the same.
      expect(requests.filter((r) => r.mark === ACTOR_MARK)).toHaveLength(1);
      expect(
        eventsOf(emitter, "tool.completed").find(
          (e) => e.payload.toolName === "delegate",
        )?.payload.result,
      ).toBe('{"data":{"line":"GUARD-LINE"}}');
      const streamed = deltas.map((d) => d.textDelta).join("");
      expect(streamed).toContain("LEAD-LINE");
      expect(streamed).not.toContain("GUARD");
      expect(new Set(deltas.map((d) => d.runtimeId))).toEqual(
        new Set(["director/lead"]),
      );
    }
  });

  it("refuses delegate for a runtime that does not declare it", async () => {
    const lead = director({ plugin: ["glance"] });
    const { llm, requests } = routedLLM({
      [PARENT_MARK]: (_params, index) =>
        index === 0
          ? toolCalls({
              name: "delegate",
              args: { target: { contract: CONTRACT }, brief: "x" },
              id: "tc-d",
            })
          : json({ line: "alone" }),
      [ACTOR_MARK]: () => json({ line: "never" }),
    });
    const emitter = makeEmitterSpy();
    await runTurnPipeline(
      input,
      [lead, actor()],
      makeDeps({
        llm,
        runtimes: [{ manifest: lead }, { manifest: actor() }],
        emitter,
      }),
    );
    expect(requests.filter((r) => r.mark === ACTOR_MARK)).toHaveLength(0);
    expect(
      eventsOf(emitter, "tool.failed").find(
        (e) => e.payload.toolName === "delegate",
      )?.payload,
    ).toMatchObject({ code: "unavailable" });
  });
});

// ── Never scheduled ─────────────────────────────────────────────────

describe("subagentOnly scheduling", () => {
  const selection = (
    runtimes: readonly RuntimeManifest[],
    manual?: { id?: string; ids?: string[] },
  ) =>
    selectTriggeredRuntimes({
      activeRuntimes: runtimes,
      manualRuntimeId: manual?.id,
      ...(manual?.ids ? { manualRuntimeIds: manual.ids } : {}),
      runtimeTriggerCounts: new Map(),
      runtimeTurnsSinceLastTrigger: new Map(),
      setupRuntimes: {},
      sessionId: "s",
      turnNumber: 1,
      logicalTurn: 1,
    });

  it("is never auto-selected, even with an auto trigger", () => {
    const odd = actor(undefined, {
      trigger: { type: "auto" },
      stage: "narrative",
    });
    expect(selection([odd]).triggered).toEqual([]);
    expect(
      shouldTrigger(odd, {
        sessionId: "s",
        turnNumber: 1,
        logicalTurn: 1,
        triggerCount: 0,
        turnsSinceLastTrigger: 99,
        pendingEventTopics: [],
      }),
    ).toBe(false);
  });

  it("refuses a manual target or batch that names one", () => {
    expect(selection([actor()], { id: "actor-pkg/guard" })).toMatchObject({
      triggered: [],
      abortReason:
        "manual-trigger: runtime runs only as a sub-agent: actor-pkg/guard",
    });
    expect(selection([actor()], { ids: ["actor-pkg/guard"] })).toMatchObject({
      triggered: [],
      abortReason: "manual-trigger: invalid or inactive runtime targets",
    });
  });

  it("rejects a recursive call to one", async () => {
    const own = actor("caller-pkg/guard");
    const main = caller(async (ctx) => {
      await ctx.recursiveCall({
        manualTrigger: { runtimeId: "caller-pkg/guard" },
      });
      return { outcome: "success", value: {} };
    });
    const { llm } = routedLLM({ [ACTOR_MARK]: () => json({ line: "x" }) });
    const result = await runTurnPipeline(
      input,
      [main.manifest, own],
      makeDeps({ llm, runtimes: [main, { manifest: own }] }),
    );
    expect(result.runtimeResults[0]).toMatchObject({
      status: "failed",
      error:
        'recursiveCall cannot run sub-agent-only runtime "caller-pkg/guard"; run it with ctx.agents.run',
    });
  });

  it("runs the caller's own sub-agent runtime by runtimeId", async () => {
    const own = actor("caller-pkg/guard");
    let answer: SubagentResult | undefined;
    const main = caller(async (ctx) => {
      answer = await ctx.agents!.run({
        target: { runtimeId: "caller-pkg/guard" },
        brief: "x",
      });
      return { outcome: "success", value: {} };
    });
    const { llm } = routedLLM({ [ACTOR_MARK]: () => json({ line: "mine" }) });
    await runTurnPipeline(
      input,
      [main.manifest, own],
      makeDeps({ llm, runtimes: [main, { manifest: own }] }),
    );
    expect(answer).toMatchObject({ ok: true, output: { line: "mine" } });
  });
});

// ── Caps and the tool filter, directly ──────────────────────────────

describe("sub-agent caps and tool filter", () => {
  it("refuses a sub-agent asking for another as unavailable", async () => {
    const runner = createSubagentRunner({ activeRuntimes: [actor()] });
    const { llm } = routedLLM({});
    const result = await runner.run({
      caller: { pluginId: "actor-pkg", runtimeId: "actor-pkg/guard", depth: 1 },
      request: { target: { contract: CONTRACT }, brief: "x" },
      input,
      deps: makeDeps({ llm, runtimes: [] }),
      executionContext: createExecutionContext(input),
      parentCallId: "p",
    });
    expect(result).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(runner.inFlight).toBe(0);
  });

  it("keeps read-only and unresolved names, drops writes, suspend and delegate at the cap", () => {
    const registry = makeRegistry();
    const executor = createToolExecutor({
      findTool: (name, context) => registry.find(name, context.pluginId),
    });
    const provider = actor(undefined, {
      tools: {
        builtin: ["delegate", "plugin-data-get", "plugin-data-set", "suspend"],
        plugin: ["peek", "poke", "unknown"],
        services: [{ contract: "inventory.items@1", name: "inventory-items" }],
        defer: ["peek", "poke", "inventory-items"],
      },
    });
    const at = (depth: number) =>
      subagentToolNames(provider, executor, {
        depth,
        sessionId: "s",
        turnId: "t",
      });
    // Imported services are read-only: the sub-agent keeps them.
    expect(at(1)).toEqual({
      builtin: ["plugin-data-get"],
      plugin: ["peek", "unknown"],
      services: [{ contract: "inventory.items@1", name: "inventory-items" }],
      defer: ["peek", "inventory-items"],
    });
    expect(at(0)?.builtin).toEqual(["delegate", "plugin-data-get"]);
  });
});

describe("delegate result envelopes", () => {
  it.each(["success", "not-found", "invalid-input"] as const)(
    "keeps code-facing output and accounting for %s",
    async (outcome) => {
      const output = { line: "Hello" };
      const answer: SubagentResult =
        outcome === "success"
          ? {
              ok: true,
              output,
              stopReason: "completed",
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          : { ok: false, error: { code: outcome, message: "No output" } };
      const inner = createToolExecutor({});
      const emitter = makeEmitterSpy();
      const { llm } = routedLLM({});
      const executor = withSubagentDelegate(
        inner,
        { inFlight: 0, run: async () => answer },
        {
          caller: {
            pluginId: "director",
            runtimeId: "director/lead",
            depth: 0,
          },
          input,
          deps: makeDeps({ llm, runtimes: [] }),
          executionContext: createExecutionContext(input),
        },
      );
      try {
        const result = await executor.execute(
          {
            toolCallId: "call",
            name: "delegate",
            arguments: JSON.stringify({
              target: { runtimeId: "guard" },
              brief: "Speak",
            }),
          },
          {
            sessionId: input.sessionId,
            turnId: input.turnId,
            pluginId: "director",
            runtimeId: "director/lead",
            authorizedToolNames: new Set(["delegate"]),
            emitter,
          },
        );
        if (answer.ok) {
          expect(JSON.parse(result.result)).toEqual({ data: output });
          expect(result.parsedResult).toBe(output);
        } else {
          expect(JSON.parse(result.result)).toEqual({ error: answer.error });
          expect(result.error).toEqual(answer.error);
          expect(result.parsedResult).toBe(answer);
          expect(eventsOf(emitter, "tool.failed")[0]?.payload.code).toBe(
            outcome,
          );
          if (outcome === "not-found") expect(result.refused).toBe(true);
          else expect(result).not.toHaveProperty("refused");
        }
      } finally {
        await inner.close();
      }
    },
  );
});
