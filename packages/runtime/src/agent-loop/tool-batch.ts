import type { LLMMessage, LLMToolCall } from "@covel/shared";
import type { ToolCallContext } from "./tool-executor.js";
import {
  buildPreToolAbortMessage,
  buildSkippedToolMessage,
} from "./turn-agent-tool-loop-messages.js";

export const MAX_PARALLEL_TOOL_CALLS = 8;

export type SkipReason =
  "hook-aborted" | "suspended" | "terminated" | "aborted";

/** Start in order, retain result order, and drain every task before rejecting. */
export async function runBounded<T>(
  tasks: readonly (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  if (!Number.isInteger(limit) || limit < 1)
    throw new RangeError("Tool pool limit must be a positive integer");
  const results: T[] = [];
  let next = 0;
  let failure: { error: unknown } | undefined;
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      while (next < tasks.length) {
        const index = next++;
        try {
          results[index] = await tasks[index]!();
        } catch (error) {
          failure ??= { error };
        }
      }
    }),
  );
  if (failure) throw failure.error;
  return results;
}

/** A null memo entry means the hook refused this call without executing it. */
export function cutToolStep(
  calls: readonly LLMToolCall[],
  start: number,
  poolable: (call: LLMToolCall) => boolean,
  effectiveCalls: ReadonlyMap<number, LLMToolCall | null> = new Map(),
): { kind: "pool" | "barrier"; indices: number[] } {
  const first = calls[start];
  if (!first) return { kind: "pool", indices: [] };
  if (!poolable(effectiveCalls.get(start) ?? first))
    return { kind: "barrier", indices: [start] };
  const indices = [start];
  for (let index = start + 1; index < calls.length; index++) {
    const call = calls[index]!;
    // Never look ahead through an original barrier to run its hook early.
    if (!poolable(call) || !poolable(effectiveCalls.get(index) ?? call)) break;
    indices.push(index);
  }
  return { kind: "pool", indices };
}

/** Skips are visible in history and trace, but never count as executed work. */
export async function emitSkippedToolCall(args: {
  call: LLMToolCall;
  context: ToolCallContext;
  reason: SkipReason;
  message: LLMMessage;
}): Promise<void> {
  if (!args.context.emitter) return;
  const { error } = JSON.parse(args.message.content as string) as {
    error: { code: string; message: string };
  };
  const payload = {
    runtimeId: args.context.runtimeId,
    pluginId: args.context.pluginId,
    toolName: args.call.name,
    toolCallId: args.call.id,
    label: `${args.context.pluginId}/${args.call.name}`,
    approvalStatus: "auto-allowed",
    code: error.code,
    error: error.message,
    skipped: true,
    skipReason: args.reason,
    durationMs: 0,
  };
  for (const type of ["tool.calling", "tool.failed"] as const) {
    try {
      await args.context.emitter.emit(type, {
        ...payload,
        ...(type === "tool.failed" ? { success: false } : {}),
      });
    } catch (error) {
      console.warn(
        `[ToolBatch] Failed to emit ${type} for ${args.call.name}:`,
        error,
      );
    }
  }
}

/** Close only the unanswered calls of this assistant turn, in model order. */
export async function closeUnansweredToolCalls(args: {
  messages: LLMMessage[];
  assistantMessageIndex: number;
  context: ToolCallContext;
  reason: Exclude<SkipReason, "hook-aborted">;
  hookAborts?: ReadonlyMap<string, string>;
  startedCallIds?: ReadonlySet<string>;
}): Promise<void> {
  const answered = new Set(
    args.messages
      .slice(args.assistantMessageIndex + 1)
      .filter((message) => message.role === "tool")
      .map((message) => message.toolCallId),
  );
  for (const call of args.messages[args.assistantMessageIndex]?.toolCalls ??
    []) {
    if (answered.has(call.id)) continue;
    const hookReason = args.hookAborts?.get(call.id);
    const reason = hookReason !== undefined ? "hook-aborted" : args.reason;
    const message =
      hookReason !== undefined
        ? buildPreToolAbortMessage({ toolCallId: call.id, reason: hookReason })
        : buildSkippedToolMessage({ toolCallId: call.id, reason: args.reason });
    args.messages.push(message);
    answered.add(call.id);
    // An admitted call already has executor trace events, even on cancellation.
    if (!args.startedCallIds?.has(call.id))
      await emitSkippedToolCall({
        call,
        context: args.context,
        reason,
        message,
      });
  }
}
