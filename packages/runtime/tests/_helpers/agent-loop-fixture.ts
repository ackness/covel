import { resolveAgentOutput } from "@covel/shared/plugin-runtime";
import type { SuspendedLoopState } from "@covel/store";
import { resolveLoopProfile } from "../../src/agent-loop/loop-profile.js";
import { makeProposal } from "@covel/plugin-handlers-utils";
/**
 * Minimal fixture for the agent tool loop: a scripted model, one recording
 * tool, and two ways to run — the loop alone (`runLoop`) or a whole runtime
 * through the turn pipeline (`runRuntime`), which settles and finalizes.
 */

import type {
  LLMAdapter,
  LLMResponse,
  LLMMessage,
  RuntimeManifest,
  RuntimeResult,
  TurnInput,
} from "@covel/shared";
import type { LoadedRuntime } from "@covel/plugin-loader";
import { tool, withPendingProposals, type ToolModule } from "@covel/tools";
import { createMemoryStore } from "@covel/store/memory";
import { z } from "zod";
import { expect } from "vitest";
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
  async execute(args: { note: string }, context) {
    return withPendingProposals({ _text: `marked:${args.note}` }, [
      makeProposal(context, "2026-10-31T00:00:00.000Z", "plugin.data", {
        namespace: "loop",
        key: "mark",
        value: args.note,
      }),
    ]);
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
      expectMatchedToolCalls(params.messages);
      requests.push({ ...params, messages: structuredClone(params.messages) });
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

/** A successful host-default submission. Content-only responses use prose(). */
export function submitted(content: string): LLMResponse {
  return toolCall("submit-output", { narrativeOutput: content }, "submit");
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
    finishReason: "tool_calls" as const,
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
  readonly messages?: LLMMessage[];
  readonly allowSuspend?: boolean;
  readonly initialState?: RunAgentToolLoopOptions["initialState"];
  readonly estimator?: (text: string) => number;
  readonly contextBudget?: RunAgentToolLoopOptions["contextBudget"];
  readonly loaded?: LoadedRuntime;
}

export async function runLoop(
  opts: LoopRunOptions,
): Promise<AgentToolLoopCompleted> {
  const runtime = opts.manifest ?? manifest();
  return (await runAgentToolLoop({
    executionContext: {
      executionId: "exec-loop",
      origin: "manual",
      countPolicy: "none",
    },
    manifest: runtime,
    input,
    loaded: opts.loaded ?? { manifest: runtime, promptTemplate: "prompt" },
    deps: {
      toolExecutor: makeExecutor(),
      ...opts.deps,
      llm: checkedLLM(opts.llm),
    },
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
    allowSuspend: opts.allowSuspend,
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
      toolExecutor: makeExecutor(),
      loadRuntime: async () => ({
        manifest: runtime,
        promptTemplate: "Do the work.",
      }),
      ...opts.deps,
      llm: checkedLLM(opts.llm),
    },
    opts.maxSteps ? { maxSteps: opts.maxSteps } : undefined,
  );
  return result.runtimeResults[0]!;
}

/** Check each occurrence separately: providers may reuse an ID across steps. */
export function expectMatchedToolCalls(
  messages: readonly {
    role: string;
    toolCalls?: readonly { id: string }[];
    toolCallId?: string;
  }[],
): void {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant" && message.toolCalls?.length) {
      expect([...pending], "previous assistant calls must be answered").toEqual(
        [],
      );
      for (const call of message.toolCalls) {
        expect(
          pending.has(call.id),
          "call IDs must be unique within a response",
        ).toBe(false);
        pending.add(call.id);
      }
    } else if (message.role === "tool") {
      expect(
        message.toolCallId && pending.delete(message.toolCallId),
        "tool result must match one unanswered call",
      ).toBe(true);
    }
  }
  expect([...pending], "every tool call must have a result").toEqual([]);
}

function checkedLLM(llm: LLMAdapter): LLMAdapter {
  return {
    ...llm,
    generate: async (params) => {
      expectMatchedToolCalls(params.messages);
      return llm.generate(params);
    },
    ...(llm.stream
      ? {
          stream: (params) => {
            expectMatchedToolCalls(params.messages);
            return llm.stream!(params);
          },
        }
      : {}),
  };
}

/** All participants wait until the last one arrives. */
export function latch(participants: number): () => Promise<void> {
  const ready = Promise.withResolvers<void>();
  let remaining = participants;
  return () => {
    if (--remaining === 0) ready.resolve();
    return ready.promise;
  };
}

/** Current admitted continuation state for tests that construct a saved agent directly. */
export function suspendedLoopState(
  runtime: RuntimeManifest,
  outputSchema?: Record<string, unknown>,
  outputContractSchema?: Record<string, unknown>,
): SuspendedLoopState {
  return {
    steps: 1,
    maxSteps: 100,
    rejectionAttempts: 0,
    correctionLimits: resolveLoopProfile(runtime).corrections,
    outputContract: resolveAgentOutput({
      manifest: runtime,
      promptTemplate: "",
      ...(outputSchema ? { outputSchema } : {}),
      ...(outputContractSchema ? { outputContractSchema } : {}),
    }),
  };
}

/** Canonical public business data supplied to a scripted model after its own call. */
export function latestToolOutput(
  messages: readonly LLMMessage[],
  toolName: string,
): Record<string, unknown> | undefined {
  const names = new Map<string, string>();
  let output: Record<string, unknown> | undefined;
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) names.set(call.id, call.name);
    if (
      message.role !== "tool" ||
      !message.toolCallId ||
      names.get(message.toolCallId) !== toolName ||
      typeof message.content !== "string"
    )
      continue;
    const envelope: unknown = JSON.parse(message.content);
    if (!envelope || typeof envelope !== "object") continue;
    if ("error" in envelope) {
      output = undefined;
      continue;
    }
    const data = "data" in envelope ? envelope.data : undefined;
    output =
      data && typeof data === "object" && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : {};
  }
  return output;
}
