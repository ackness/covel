/**
 * Minimal fixture for the agent tool loop: a scripted model, one recording
 * tool, and two ways to run — the loop alone (`runLoop`) or a whole runtime
 * through the turn pipeline (`runRuntime`), which settles and finalizes.
 */

import type {
  LLMAdapter,
  LLMResponse,
  RuntimeManifest,
  RuntimeResult,
  TurnInput,
} from "@covel/shared";
import type { LoadedRuntime } from "@covel/plugin-loader";
import { tool, withPendingProposals, type ToolModule } from "@covel/tools";
import { createMemoryStore } from "@covel/store/memory";
import { z } from "zod";
import {
  runAgentToolLoop,
  type AgentToolLoopCompleted,
  type RunAgentToolLoopOptions,
} from "../../src/agent-loop/turn-agent-tool-loop.js";
import { createToolExecutor } from "../../src/agent-loop/tool-executor.js";
import { runTurnPipeline } from "../../src/turn-executor/turn-executor.js";
import type { TurnExecutorDeps } from "../../src/turn-executor/turn-executor.js";

export const input: TurnInput = {
  origin: "player",
  sessionId: "sess-loop",
  turnId: "turn-loop",
  playerMessage: "go",
};

export function manifest(
  overrides?: Partial<RuntimeManifest>,
): RuntimeManifest {
  return {
    name: "plug/loop",
    pluginId: "plug",
    description: "loop fixture",
    runtimeType: "agent",
    stage: "narrative",
    outputKind: "system",
    trigger: { type: "auto" },
    tools: { plugin: ["mark"] },
    maxRetries: 0,
    ...overrides,
  } as RuntimeManifest;
}

export const markTool = tool({
  name: "mark",
  description: "records a marker",
  parameters: z.object({ note: z.string() }),
  async execute(args: { note: string }) {
    return withPendingProposals({ _text: `marked:${args.note}` }, [
      {
        type: "plugin.data",
        payload: { namespace: "loop", key: "mark", value: args.note },
      },
    ] as never);
  },
});

export const saveTool = tool({
  name: "save",
  description: "saves the work",
  parameters: z.object({}),
  async execute() {
    return { saved: true };
  },
});

export const doneTool = tool({
  name: "runtime-done",
  description: "declare completion",
  parameters: z.object({}),
  async execute() {
    return { _covelRuntimeDone: true, reason: "done" };
  },
});

export function makeExecutor(modules: readonly ToolModule[] = [markTool]) {
  return createToolExecutor({
    findTool: (name) => modules.find((module) => module.name === name),
  });
}

export type GenerateParams = Parameters<LLMAdapter["generate"]>[0];

/** A model whose reply is computed from the request. */
export function scriptedLLM(
  reply: (params: GenerateParams, call: number) => LLMResponse,
): LLMAdapter & { readonly requests: GenerateParams[] } {
  const requests: GenerateParams[] = [];
  return {
    requests,
    async generate(params) {
      requests.push(params);
      return reply(params, requests.length);
    },
  };
}

/** A model that returns `script` in order and repeats the last reply. */
export function queuedLLM(script: readonly LLMResponse[]) {
  return scriptedLLM(
    (_params, call) => script[Math.min(call, script.length) - 1]!,
  );
}

export function prose(content: string): LLMResponse {
  return {
    content,
    toolCalls: [],
    finishReason: "stop",
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

export function toolCall(
  name: string,
  args: Record<string, unknown>,
  id = "tc-1",
  content: string | null = null,
): LLMResponse {
  return {
    content,
    toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
    finishReason: "tool_calls",
    usage: { inputTokens: 3, outputTokens: 2 },
  };
}

export interface LoopRunOptions {
  readonly llm: LLMAdapter;
  readonly manifest?: RuntimeManifest;
  readonly deps?: Record<string, unknown>;
  readonly maxSteps?: number;
  readonly timeoutMs?: number;
  readonly hookPipeline?: RunAgentToolLoopOptions["hookPipeline"];
  readonly messages?: { role: string; content: string }[];
  readonly initialState?: RunAgentToolLoopOptions["initialState"];
  readonly estimator?: (text: string) => number;
  readonly contextBudget?: RunAgentToolLoopOptions["contextBudget"];
  readonly loaded?: LoadedRuntime;
}

const loaded = { promptTemplate: "prompt" } as unknown as LoadedRuntime;

export async function runLoop(
  opts: LoopRunOptions,
): Promise<AgentToolLoopCompleted> {
  return (await runAgentToolLoop({
    executionContext: {
      executionId: "exec-loop",
      origin: "manual",
      countPolicy: "none",
    },
    manifest: opts.manifest ?? manifest(),
    input,
    loaded: opts.loaded ?? loaded,
    deps: { llm: opts.llm, toolExecutor: makeExecutor(), ...opts.deps },
    maxSteps: opts.maxSteps ?? 5,
    timeoutMs: opts.timeoutMs ?? 10_000,
    messages: (opts.messages ?? [
      { role: "system", content: "sys" },
      { role: "user", content: "go" },
    ]) as never,
    ...(opts.estimator && opts.contextBudget
      ? { estimator: opts.estimator, contextBudget: opts.contextBudget }
      : {}),
    hookPipeline: opts.hookPipeline,
    initialState: opts.initialState,
    startTime: Date.now(),
    runId: "run-loop",
  })) as AgentToolLoopCompleted;
}

/** Run one agent runtime through the turn pipeline and return its result. */
export async function runRuntime(opts: {
  readonly llm: LLMAdapter;
  readonly manifest?: RuntimeManifest;
  readonly deps?: Partial<TurnExecutorDeps>;
  readonly maxSteps?: number;
}): Promise<RuntimeResult> {
  const runtime: RuntimeManifest = {
    ...(opts.manifest ?? manifest()),
    trigger: { type: "manual" },
  };
  const store = createMemoryStore();
  const result = await runTurnPipeline(
    { ...input, origin: "manual", manualTrigger: { runtimeId: runtime.name } },
    [runtime],
    {
      store,
      llm: opts.llm,
      toolExecutor: makeExecutor(),
      loadRuntime: async () => ({
        manifest: runtime,
        promptTemplate: "Do the work.",
      }),
      ...opts.deps,
    },
    opts.maxSteps ? { maxSteps: opts.maxSteps } : undefined,
  );
  return result.runtimeResults[0]!;
}
