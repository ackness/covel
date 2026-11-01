import { runDelegateBatch } from "./subagent-delegate-batch.js";
import { forkWorldModelView } from "../function-runtime/world-model-view.js";
import { characterByName } from "../orchestration/policy-tools.js";
import { ToolError } from "@covel/shared";
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
  SubagentResult,
  TurnInput,
} from "@covel/shared";
import { renderToolSuccess, renderToolError } from "./tool-result-text.js";
import {
  DELEGATE_TOOL_NAME,
  DELEGATE_BATCH_TOOL_NAME,
  delegateParametersSchema,
  parseJsonText,
} from "@covel/tools";
import type { TurnExecutorDeps } from "../turn-executor/turn-executor-types.js";
import type { SubagentCaller, SubagentRunner } from "./subagent-runner.js";
import type { OperationStage } from "../operations/operation-stage.js";
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
  /**
   * The caller's operation stage. Each sub-agent stages its write-service
   * operations in a child of it, kept when the sub-agent succeeds.
   */
  readonly operations?: OperationStage;
}

const APPROVAL: ApprovalStatus = "auto-allowed";

export function withSubagentDelegate(
  inner: ToolExecutor,
  runner: SubagentRunner,
  scope: SubagentDelegateScope,
): ToolExecutor {
  return {
    getToolInfo: (name, context) => inner.getToolInfo(name, context),
    async execute(call, context) {
      if (![DELEGATE_TOOL_NAME, DELEGATE_BATCH_TOOL_NAME].includes(call.name))
        return inner.execute(call, context);
      markPrivateDelegation(call, runner, scope);
      // Refusals still use the normal final authorization boundary. Learn
      // provenance first so its persistence cannot expose private arguments.
      if (context.authorizedToolNames?.has(call.name) !== true)
        return inner.execute(call, context);
      return call.name === DELEGATE_BATCH_TOOL_NAME
        ? runDelegateBatch(call, context, runner, scope)
        : runDelegate(call, context, runner, scope);
    },
  };
}

function markPrivateDelegation(
  call: ToolCall,
  runner: SubagentRunner,
  scope: SubagentDelegateScope,
): void {
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
        Array.isArray(args.requests)
        ? args.requests
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
      scope.caller,
    );
    if (kind) scope.deps.delegation?.privacy.mark(call.toolCallId, kind);
  }
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
  let characterId: string | undefined;
  if (parsed.data.character !== undefined) {
    try {
      characterId = characterByName(context.world, parsed.data.character).id;
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      return failed(call, context, startTime, {
        ok: false,
        error: {
          code: error.code === "ambiguous" ? "ambiguous" : "not-found",
          message: error.message,
        },
      });
    }
  }
  const worldFork = context.world
    ? forkWorldModelView(context.world, () => context.signal?.throwIfAborted())
    : undefined;
  const operations = scope.operations?.child();
  let accepted = false;
  try {
    await emitToolEvent(context, call, "tool.calling", {
      arguments: call.arguments,
      source: "builtin",
    });
    const { target, brief, data, maxSteps } = parsed.data;
    // Isolate this invocation's operations from earlier or concurrent calls.
    let result: SubagentResult;
    try {
      result = await runner.run({
        caller: scope.caller,
        request: {
          target,
          brief,
          ...(characterId !== undefined ? { characterId } : {}),
          ...(parsed.data.instruction !== undefined
            ? { instruction: parsed.data.instruction }
            : {}),
          ...(data !== undefined ? { data } : {}),
          ...(maxSteps !== undefined ? { budget: { maxSteps } } : {}),
        },
        input: scope.input,
        world: worldFork?.world,
        deps: scope.deps,
        executionContext: scope.executionContext,
        ...(operations ? { operations } : {}),
        parentCallId: call.toolCallId,
        ...(context.signal ? { parentSignal: context.signal } : {}),
      });
    } catch (error) {
      operations?.discard();
      throw error;
    }
    if (!result.ok) {
      operations?.discard();
      return failed(call, context, startTime, result);
    }
    const staged = operations?.held() ?? [];
    // A completing `delegate` hands the original output to the caller's output
    // gate; only the model-facing envelope carries the staged notice. Stop
    // reason and usage stay on the sub-agent's own `subagent.completed` trace.
    const output = result.output;
    const resultText = renderToolSuccess({
      content: output,
      locale: scope.input.locale,
      stagedOperations: {
        count: staged.length,
        kinds: staged.flatMap((operation) =>
          operation.writes.map((write) => write.type),
        ),
      },
    });
    await emitToolEvent(context, call, "tool.completed", {
      result: resultText,
      parsedResult: output,
      durationMs: Date.now() - startTime,
      success: true,
    });
    context.signal?.throwIfAborted();
    worldFork?.accept();
    operations?.commit();
    accepted = true;
    return {
      toolCallId: call.toolCallId,
      name: call.name,
      result: resultText,
      parsedResult: output,
      success: true,
      approvalStatus: APPROVAL,
    };
  } finally {
    if (!accepted) operations?.discard();
    worldFork?.discard();
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
    approvalStatus: APPROVAL,
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
      approvalStatus: APPROVAL,
      ...extra,
    });
  } catch (error) {
    console.warn(`[subagent] failed to emit ${type} for delegate:`, error);
  }
}
