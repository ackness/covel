import type { ToolExecutionContext, ToolExecutionResult } from "@covel/shared";
import type { ToolRegistry, HookRegistry, RegisteredTool } from "@covel/plugin-runtime";

export interface ToolExecutorDeps {
  toolRegistry: ToolRegistry;
  hookRegistry: HookRegistry;
}

export interface ToolCallRequest {
  /** Qualified tool ID: pluginId:toolId */
  qualifiedToolId: string;
  input: unknown;
  runtimeId: string;
  pluginId: string;
  locale: string;
}

export interface ToolCallResult {
  output: unknown;
  proposals: Array<{ kind: string; payload: unknown }>;
  /** Whether the call was blocked by a hook. */
  blocked: boolean;
}

/**
 * Execute a tool call with PreToolUse/PostToolUse hook guards.
 */
export async function executeTool(
  deps: ToolExecutorDeps,
  request: ToolCallRequest
): Promise<ToolCallResult> {
  const tool = deps.toolRegistry.getByQualifiedId(request.qualifiedToolId);
  if (!tool) {
    throw new Error(`Tool "${request.qualifiedToolId}" not found.`);
  }

  // ── PreToolUse hooks ──────────────────────────────────────────
  const preHooks = deps.hookRegistry.getHooksForEvent("PreToolUse", {
    toolId: request.qualifiedToolId,
    runtimeId: request.runtimeId,
    pluginId: request.pluginId,
  });

  let currentInput = request.input;

  for (const hook of preHooks) {
    // First-round: only command handlers
    if (hook.definition.handlerKind !== "command") continue;

    const result = await hook.handler({
      event: "PreToolUse",
      runtimeId: request.runtimeId,
      pluginId: request.pluginId,
      locale: request.locale,
      toolCall: {
        toolId: request.qualifiedToolId,
        input: currentInput,
      },
    });

    if (!result.allow) {
      return { output: null, proposals: [], blocked: true };
    }

    if (result.rewrittenInput !== undefined) {
      currentInput = result.rewrittenInput;
    }
  }

  // ── Execute the tool ──────────────────────────────────────────
  const ctx: ToolExecutionContext = {
    input: currentInput,
    runtimeId: request.runtimeId,
    pluginId: request.pluginId,
    locale: request.locale,
  };

  const toolResult: ToolExecutionResult = await tool.handler(ctx);

  // ── PostToolUse hooks ─────────────────────────────────────────
  const postHooks = deps.hookRegistry.getHooksForEvent("PostToolUse", {
    toolId: request.qualifiedToolId,
    runtimeId: request.runtimeId,
    pluginId: request.pluginId,
  });

  for (const hook of postHooks) {
    if (hook.definition.handlerKind !== "command") continue;

    await hook.handler({
      event: "PostToolUse",
      runtimeId: request.runtimeId,
      pluginId: request.pluginId,
      locale: request.locale,
      toolCall: {
        toolId: request.qualifiedToolId,
        input: currentInput,
        output: toolResult.output,
      },
    });
  }

  return {
    output: toolResult.output,
    proposals: toolResult.proposals ?? [],
    blocked: false,
  };
}
