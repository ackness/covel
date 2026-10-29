/**
 * The `delegate` tool of agent runtimes: a tool-executor wrapper that answers
 * `delegate` calls by running a sub-agent, and forwards every other call.
 *
 * Wrapping the executor keeps the agent loop and the executor itself
 * unchanged. The call is traced and returned in the same shape an ordinary
 * tool call has (`tool.calling` / `tool.completed` / `tool.failed`,
 * `approvalStatus: "auto-allowed"`), so the loop records it like any other.
 */

import type {
  ApprovalStatus,
  ExecutionContext,
  SubagentErrorCode,
  SubagentResult,
  TurnInput,
} from "@covel/shared";
import { modelFacingJson } from "@covel/shared";
import {
  DELEGATE_TOOL_NAME,
  delegateParametersSchema,
  parseJsonText,
} from "@covel/tools";
import type { TurnExecutorDeps } from "../turn-executor/turn-executor-types.js";
import type { SubagentCaller, SubagentRunner } from "./subagent-runner.js";
import type {
  ToolCall,
  ToolCallContext,
  ToolCallResult,
  ToolExecutor,
} from "./tool-executor.js";

/** The calling runtime and what its sub-agents inherit. */
export interface SubagentDelegateScope {
  readonly caller: SubagentCaller;
  readonly input: TurnInput;
  /** The caller's dependencies with the unwrapped tool executor. */
  readonly deps: TurnExecutorDeps;
  readonly executionContext: ExecutionContext;
}

const APPROVAL: ApprovalStatus = "auto-allowed";

/** Executor error codes of the trace, for a sub-agent's error code. */
const TRACE_CODES: Readonly<Record<SubagentErrorCode, string>> = {
  "invalid-input": "INVALID_ARGS",
  "not-found": "EXECUTION_ERROR",
  ambiguous: "EXECUTION_ERROR",
  unavailable: "EXECUTION_ERROR",
  timeout: "TIMEOUT",
  cancelled: "CANCELLED",
  internal: "EXECUTION_ERROR",
};

export function withSubagentDelegate(
  inner: ToolExecutor,
  runner: SubagentRunner,
  scope: SubagentDelegateScope,
): ToolExecutor {
  return {
    getToolInfo: (name, context) => inner.getToolInfo(name, context),
    async execute(call, context) {
      // An undeclared `delegate` goes to the executor, which refuses it.
      if (
        call.name !== DELEGATE_TOOL_NAME ||
        context.authorizedToolNames?.has(DELEGATE_TOOL_NAME) !== true
      )
        return inner.execute(call, context);
      return runDelegate(call, context, runner, scope);
    },
  };
}

async function runDelegate(
  call: ToolCall,
  context: ToolCallContext,
  runner: SubagentRunner,
  scope: SubagentDelegateScope,
): Promise<ToolCallResult> {
  const startTime = Date.now();
  context.signal?.throwIfAborted();
  let args: unknown;
  try {
    args = parseJsonText(call.arguments);
  } catch {
    return failed(call, context, startTime, {
      ok: false,
      error: {
        code: "invalid-input",
        message: `Arguments for tool "${call.name}" are not valid JSON. Ensure the arguments object is properly formatted JSON.`,
      },
    });
  }
  const parsed = delegateParametersSchema.safeParse(args);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const at = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
    return failed(call, context, startTime, {
      ok: false,
      error: {
        code: "invalid-input",
        message: `Invalid delegate arguments${at}: ${issue?.message ?? "unknown problem"}`,
      },
    });
  }
  await emitToolEvent(context, call, "tool.calling", {
    arguments: call.arguments,
    source: "builtin",
  });
  const { target, brief, data, maxSteps } = parsed.data;
  const result = await runner.run({
    caller: scope.caller,
    request: {
      target,
      brief,
      ...(data !== undefined ? { data } : {}),
      ...(maxSteps !== undefined ? { budget: { maxSteps } } : {}),
    },
    input: scope.input,
    deps: scope.deps,
    executionContext: scope.executionContext,
    parentCallId: call.toolCallId,
    ...(context.signal ? { parentSignal: context.signal } : {}),
  });
  if (!result.ok) return failed(call, context, startTime, result);
  const resultText = JSON.stringify(modelFacingJson(result.output));
  await emitToolEvent(context, call, "tool.completed", {
    result: resultText,
    parsedResult: result,
    durationMs: Date.now() - startTime,
    success: true,
  });
  return {
    toolCallId: call.toolCallId,
    name: call.name,
    result: resultText,
    parsedResult: result,
    success: true,
    approvalStatus: APPROVAL,
  };
}

/**
 * A failed `delegate` call. Only an invalid request is the model's own
 * mistake to correct; the other errors are refusals it can work around.
 */
async function failed(
  call: ToolCall,
  context: ToolCallContext,
  startTime: number,
  result: Extract<SubagentResult, { ok: false }>,
): Promise<ToolCallResult> {
  const { code, message } = result.error;
  await emitToolEvent(context, call, "tool.failed", {
    code: TRACE_CODES[code],
    error: message,
    durationMs: Date.now() - startTime,
    success: false,
  });
  return {
    toolCallId: call.toolCallId,
    name: call.name,
    result: JSON.stringify({ success: false, error: message, code }),
    parsedResult: result,
    success: false,
    ...(code === "invalid-input" ? {} : { refused: true as const }),
    approvalStatus: APPROVAL,
  };
}

/** The identity envelope `ToolExecutor` traces every tool call with. */
async function emitToolEvent(
  context: ToolCallContext,
  call: ToolCall,
  type: "tool.calling" | "tool.completed" | "tool.failed",
  extra: Record<string, unknown>,
): Promise<void> {
  if (!context.emitter) return;
  try {
    await context.emitter.emit(type, {
      runtimeId: context.runtimeId,
      pluginId: context.pluginId,
      toolName: call.name,
      toolCallId: call.toolCallId,
      label: `${context.pluginId}/${call.name}`,
      approvalStatus: APPROVAL,
      ...extra,
    });
  } catch (error) {
    console.warn(`[subagent] failed to emit ${type} for delegate:`, error);
  }
}
