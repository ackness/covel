import type {
  ApprovalStatus,
  ExecutionContext,
  SubagentResult,
  TurnInput,
} from "@covel/shared";
import {
  DELEGATE_BATCH_TOOL_NAME,
  DELEGATE_TOOL_NAME,
  delegateParametersSchema,
  parseJsonText,
} from "@covel/tools";
import type { PluginDataVisibility } from "../function-runtime/upstream-plugin-data.js";
import type { OperationStage } from "../operations/operation-stage.js";
import type { PrivateDelegationProjection } from "../orchestration/private-projections.js";
import type { TurnExecutorDeps } from "../turn-executor/turn-executor-types.js";
import type { SubagentCaller, SubagentRunner } from "./subagent-runner.js";
import type {
  ToolCall,
  ToolCallContext,
  ToolCallResult,
} from "./tool-executor.js";
import { renderToolError } from "./tool-result-text.js";

/** The calling runtime and what its sub-agents inherit. */
export interface SubagentDelegateScope {
  readonly caller: SubagentCaller;
  readonly input: TurnInput;
  /** The caller's dependencies with the unwrapped tool executor. */
  readonly deps: TurnExecutorDeps;
  readonly executionContext: ExecutionContext;
  /**
   * The caller's operation stage. Each sub-agent stages its write-service
   * operations in a child of it, kept when the sub-agent succeeds.
   */
  readonly operations?: OperationStage;
  /**
   * The caller's plugin-data visibility, used when the tool call context does
   * not supply one directly.
   */
  readonly pluginDataVisibility?: PluginDataVisibility;
}

export const DELEGATE_APPROVAL: ApprovalStatus = "auto-allowed";

export function markPrivateDelegation(
  call: ToolCall,
  runner: SubagentRunner,
  caller: Pick<SubagentCaller, "pluginId">,
  privacy: PrivateDelegationProjection | undefined,
): void {
  if (![DELEGATE_TOOL_NAME, DELEGATE_BATCH_TOOL_NAME].includes(call.name))
    return;
  let args: unknown;
  try {
    args = parseJsonText(call.arguments);
  } catch {
    return;
  }
  const entries: unknown[] =
    call.name === DELEGATE_BATCH_TOOL_NAME
      ? args &&
        typeof args === "object" &&
        "requests" in args &&
        Array.isArray((args as { requests: unknown }).requests)
        ? (args as { requests: unknown[] }).requests
        : []
      : [args];
  for (const entry of entries) {
    const target = delegateParametersSchema.shape.target.safeParse(
      entry && typeof entry === "object" && "target" in entry
        ? entry.target
        : undefined,
    );
    if (!target.success) continue;
    const kind = runner.privateTargetKind(
      { target: target.data, brief: "Private delegation" },
      caller,
    );
    if (kind) privacy?.mark(call.toolCallId, kind);
  }
}

/**
 * A failed `delegate` call. Only an invalid request is the model's own
 * mistake to correct; the other errors are refusals it can work around.
 */
export async function failed(
  call: ToolCall,
  context: ToolCallContext,
  startTime: number,
  result: Extract<SubagentResult, { ok: false }>,
): Promise<ToolCallResult> {
  const { code, message } = result.error;
  await emitToolEvent(context, call, "tool.failed", {
    code,
    error: message,
    durationMs: Date.now() - startTime,
    success: false,
  });
  return {
    toolCallId: call.toolCallId,
    name: call.name,
    result: renderToolError(result.error),
    error: result.error,
    parsedResult: result,
    success: false,
    ...(code === "invalid-input" ? {} : { refused: true as const }),
    approvalStatus: DELEGATE_APPROVAL,
  };
}

/** The identity envelope `ToolExecutor` traces every tool call with. */
export async function emitToolEvent(
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
      approvalStatus: DELEGATE_APPROVAL,
      ...extra,
    });
  } catch (error) {
    console.warn(`[subagent] failed to emit ${type} for delegate:`, error);
  }
}
