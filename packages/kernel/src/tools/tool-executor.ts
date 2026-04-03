import type { ToolExecutionContext, ToolExecutionResult } from "@covel/shared";
import type { ScopedToolRegistry, ScopedHookRegistry, RegisteredTool } from "@covel/plugin-runtime";
import { DEFAULT_TOOL_TIMEOUT_MS } from "../types.js";

export interface ToolExecutorDeps {
  toolRegistry: ScopedToolRegistry;
  hookRegistry: ScopedHookRegistry;
}

export interface ToolCallRequest {
  /** Qualified tool ID: pluginId:toolId */
  qualifiedToolId: string;
  input: unknown;
  runtimeId: string;
  pluginId: string;
  locale: string;
  /** Per-tool-call timeout in milliseconds. Default: 10000 (10s). */
  timeoutMs?: number;
  /** Current turn state snapshot to inject into tool context. */
  state?: Record<string, unknown>;
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

  // ── Execute the tool (with timeout) ────────────────────────────
  const ctx: ToolExecutionContext = {
    input: currentInput,
    runtimeId: request.runtimeId,
    pluginId: request.pluginId,
    locale: request.locale,
    state: request.state,
  };

  const timeoutMs = request.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const toolResult: ToolExecutionResult = await Promise.race([
    tool.handler(ctx).finally(() => clearTimeout(timeoutHandle)),
    new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`Tool "${request.qualifiedToolId}" timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    }),
  ]);

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
