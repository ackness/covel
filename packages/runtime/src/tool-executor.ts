/**
 * ToolExecutor — resolves, validates, and executes tool calls from LLM responses.
 *
 * Pipeline per call:
 *   1. Look up tool in ToolRegistry by name
 *   2. Check approval pipeline (if configured)
 *   3. Parse arguments JSON
 *   4. Execute tool.execute(params, context)
 *   5. Record call to DataStore (if available)
 *   6. Return result string for LLM
 */

import {
  ToolValidationError,
  getPendingProposals,
  getToolContent,
  type ToolModule,
} from '@covel/tools';
import type { DataStore } from '@covel/store';
import type { ApprovalPipeline } from '@covel/approval';
import type { ApprovalStatus, Proposal } from '@covel/shared';

// ── Structured tool error shape (returned to LLM) ────────────────

type ToolErrorCode = 'NOT_FOUND' | 'DENIED' | 'INVALID_ARGS' | 'VALIDATION_ERROR' | 'EXECUTION_ERROR';

function toolError(
  code: ToolErrorCode,
  message: string,
  details?: string[],
): string {
  const payload: Record<string, unknown> = { success: false, error: message, code };
  if (details && details.length > 0) payload.details = details;
  return JSON.stringify(payload);
}

// ── Types ────────────────────────────────────────────────────────

export interface ToolCall {
  readonly toolCallId: string;
  readonly name: string;
  readonly arguments: string; // JSON string from LLM
}

export interface ToolCallContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly pluginId: string;
  readonly runtimeId: string;
  readonly pendingProposals?: readonly Proposal[];
  /** Optional trace emitter — when present, tool.calling / tool.completed / tool.failed are traced. */
  readonly emitter?: import('./turn-emitter.js').TurnEmitter;
}

export interface ToolCallResult {
  readonly toolCallId: string;
  readonly name: string;
  readonly result: string;  // JSON string for LLM
  readonly parsedResult: unknown; // Parsed result for framework use
  readonly pendingProposals?: readonly Proposal[];
  readonly success: boolean;
  readonly approvalStatus?: ApprovalStatus;
}

export interface ToolInfo {
  readonly name: string;
  readonly description: string;
  readonly jsonSchema: Readonly<Record<string, unknown>>;
}

export interface ToolExecutor {
  execute(call: ToolCall, context: ToolCallContext): Promise<ToolCallResult>;
  /**
   * Look up a tool's LLM-facing shape (name/description/jsonSchema).
   *
   * `context` is optional so legacy call sites keep working, but passing it
   * lets the resolver return a session-specific variant — e.g.
   * `create-character` / `update-character` with `fields` typed against the
   * active world's CharacterAttributeSchema. Without context the generic
   * variant is returned.
   */
  getToolInfo(name: string, context?: ToolCallContext): ToolInfo | undefined;
}

// ── Implementation ───────────────────────────────────────────────

export interface ToolExecutorConfig {
  /** Tool lookup function — returns the tool module by name. Context enables per-plugin scoping. */
  readonly findTool: (name: string, context?: ToolCallContext) => ToolModule | undefined;
  /** Optional DataStore for recording tool calls. */
  readonly store?: DataStore;
  /** Optional approval pipeline for permission checking. */
  readonly approval?: ApprovalPipeline;
  /** Optional function to determine tool source category. */
  readonly getToolSource?: (toolName: string) => 'builtin' | 'local' | 'third-party';
}

function toolLabel(pluginId: string, toolName: string): string {
  return `${pluginId}/${toolName}`;
}

async function emitToolCalling(
  ctx: ToolCallContext,
  call: ToolCall,
  source: 'builtin' | 'local' | 'third-party',
  approvalStatus: ApprovalStatus,
): Promise<void> {
  if (!ctx.emitter) return;
  await ctx.emitter.emit('tool.calling', {
    runtimeId: ctx.runtimeId,
    pluginId: ctx.pluginId,
    toolName: call.name,
    toolCallId: call.toolCallId,
    label: toolLabel(ctx.pluginId, call.name),
    arguments: call.arguments,
    source,
    approvalStatus,
  });
}

async function emitToolCompleted(
  ctx: ToolCallContext,
  call: ToolCall,
  result: string,
  parsedResult: unknown,
  durationMs: number,
  approvalStatus: ApprovalStatus,
): Promise<void> {
  if (!ctx.emitter) return;
  await ctx.emitter.emit('tool.completed', {
    runtimeId: ctx.runtimeId,
    pluginId: ctx.pluginId,
    toolName: call.name,
    toolCallId: call.toolCallId,
    label: toolLabel(ctx.pluginId, call.name),
    result,
    parsedResult,
    durationMs,
    approvalStatus,
    success: true,
  });
}

async function emitToolFailed(
  ctx: ToolCallContext,
  call: ToolCall,
  code: ToolErrorCode,
  error: string,
  details: string[] | undefined,
  durationMs: number,
  approvalStatus: ApprovalStatus,
): Promise<void> {
  if (!ctx.emitter) return;
  await ctx.emitter.emit('tool.failed', {
    runtimeId: ctx.runtimeId,
    pluginId: ctx.pluginId,
    toolName: call.name,
    toolCallId: call.toolCallId,
    label: toolLabel(ctx.pluginId, call.name),
    code,
    error,
    ...(details && details.length > 0 ? { details } : {}),
    durationMs,
    approvalStatus,
    success: false,
  });
}

export function createToolExecutor(config: ToolExecutorConfig): ToolExecutor {
  return {
    getToolInfo(name: string, context?: ToolCallContext): ToolInfo | undefined {
      const tool = config.findTool(name, context);
      if (!tool) return undefined;
      return { name: tool.name, description: tool.description, jsonSchema: tool.jsonSchema as Record<string, unknown> };
    },

    async execute(call: ToolCall, context: ToolCallContext): Promise<ToolCallResult> {
      const startTime = Date.now();

      // 1. Find tool (scoped to calling plugin if context available)
      const tool = config.findTool(call.name, context);
      if (!tool) {
        const errorResult = toolError('NOT_FOUND', `Unknown tool: ${call.name}. Check the tool name and try again.`);
        await recordCall(config.store, call, context, errorResult, startTime, false, 'auto-allowed');
        await emitToolFailed(context, call, 'NOT_FOUND', `Unknown tool: ${call.name}`, undefined, Date.now() - startTime, 'auto-allowed');
        return { toolCallId: call.toolCallId, name: call.name, result: errorResult, parsedResult: null, success: false, approvalStatus: 'auto-allowed' as const };
      }

      // 2. Check approval
      let approvalStatus: ApprovalStatus = 'auto-allowed';
      const toolSource = config.getToolSource?.(call.name) ?? 'local';

      if (config.approval) {
        const checkResult = config.approval.check(
          {
            toolName: call.name,
            pluginId: context.pluginId,
            runtimeId: context.runtimeId,
            input: tryParseJson(call.arguments),
            turnId: context.turnId,
            sessionId: context.sessionId,
          },
          toolSource,
        );

        if (checkResult.needsApproval) {
          // Check session-level prior approval
          if (config.approval.hasSessionAllow(context.sessionId, call.name, context.pluginId)) {
            approvalStatus = 'user-allowed';
          } else {
            // Denied — do not execute
            approvalStatus = 'user-denied';
            const denyResult = toolError('DENIED', `Tool "${call.name}" was denied by the approval policy. Reason: ${checkResult.reason}. Do not retry this tool call.`);
            await recordCall(config.store, call, context, denyResult, startTime, false, approvalStatus);
            await emitToolFailed(context, call, 'DENIED', checkResult.reason ?? 'denied by approval policy', undefined, Date.now() - startTime, approvalStatus);
            return { toolCallId: call.toolCallId, name: call.name, result: denyResult, parsedResult: null, success: false, approvalStatus };
          }
        }
      }

      // 3. Parse arguments
      let params: unknown;
      try {
        params = JSON.parse(call.arguments);
      } catch {
        const errorResult = toolError('INVALID_ARGS', `Arguments for tool "${call.name}" are not valid JSON. Ensure the arguments object is properly formatted JSON.`);
        await recordCall(config.store, call, context, errorResult, startTime, false, approvalStatus);
        await emitToolFailed(context, call, 'INVALID_ARGS', 'arguments are not valid JSON', undefined, Date.now() - startTime, approvalStatus);
        return { toolCallId: call.toolCallId, name: call.name, result: errorResult, parsedResult: null, success: false, approvalStatus };
      }

      // Emit calling AFTER arg-parse so the trace carries the real arguments
      await emitToolCalling(context, call, toolSource, approvalStatus);

      // 4. Execute
      try {
        const execContext = {
          sessionId: context.sessionId,
          turnId: context.turnId,
          pluginId: context.pluginId,
          runtimeId: context.runtimeId,
          pendingProposals: context.pendingProposals,
        };
        const rawResult = await tool.execute(params, execContext);
        const parsedResult = getToolContent(rawResult);
        const pendingProposals = getPendingProposals(rawResult);

        // Text-first convention: if the tool result is an object with a
        // `_text` string field, send ONLY the text as the LLM-facing payload
        // (instead of JSON-stringifying the whole object). This keeps LLM
        // prompts human-readable while framework tracing still gets the full
        // structured object via `parsedResult`. Falls back to JSON.stringify
        // for tools that don't opt in.
        const resultStr =
          parsedResult && typeof parsedResult === 'object' && typeof (parsedResult as { _text?: unknown })._text === 'string'
            ? (parsedResult as { _text: string })._text
            : JSON.stringify(parsedResult);

        const durationMs = Date.now() - startTime;
        await recordCall(config.store, call, context, resultStr, startTime, true, approvalStatus);
        await emitToolCompleted(context, call, resultStr, parsedResult, durationMs, approvalStatus);
        return {
          toolCallId: call.toolCallId,
          name: call.name,
          result: resultStr,
          parsedResult,
          pendingProposals,
          success: true,
          approvalStatus,
        };
      } catch (error: unknown) {
        let errorResult: string;
        let code: ToolErrorCode;
        let details: string[] | undefined;
        let message: string;
        if (error instanceof ToolValidationError) {
          // Dedupe Zod issues by path so only the FIRST issue on any given
          // field is reported. Zod v4 has a quirk where `z.array(...).max(N)`
          // will emit a bogus `too_big: expected string to have <=N characters`
          // alongside the real `invalid_type: expected array, received string`
          // when the LLM sends a JSON-stringified array. Feeding both to the
          // LLM confuses it into fixing a phantom "string length" problem
          // while the real fix ("send an array") is buried. Keeping only the
          // first issue per path eliminates the contradiction without losing
          // information — multi-field errors still list each field once.
          const seenPaths = new Set<string>();
          const dedupedDetails: typeof error.details = [];
          for (const detail of error.details) {
            const key = detail.path ?? '';
            if (seenPaths.has(key)) continue;
            seenPaths.add(key);
            dedupedDetails.push(detail);
          }
          details = dedupedDetails.map(d => `${d.path}: ${d.message}`);
          message = dedupedDetails.map(d => d.message).join('; ');
          code = 'VALIDATION_ERROR';
          errorResult = toolError(
            code,
            `Invalid parameters for tool "${call.name}": ${message}. Fix the highlighted fields and retry.`,
            details,
          );
        } else {
          message = error instanceof Error ? error.message : String(error);
          code = 'EXECUTION_ERROR';
          errorResult = toolError(code, `Tool "${call.name}" failed during execution: ${message}`);
        }
        await recordCall(config.store, call, context, errorResult, startTime, false, approvalStatus);
        await emitToolFailed(context, call, code, message, details, Date.now() - startTime, approvalStatus);
        return { toolCallId: call.toolCallId, name: call.name, result: errorResult, parsedResult: null, success: false, approvalStatus };
      }
    },
  };
}

function tryParseJson(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function recordCall(
  store: DataStore | undefined,
  call: ToolCall,
  context: ToolCallContext,
  result: string,
  startTime: number,
  success: boolean,
  approvalStatus: string,
): Promise<void> {
  if (!store) return;
  try {
    await store.saveToolCall({
      id: crypto.randomUUID(),
      sessionId: context.sessionId,
      turnId: context.turnId,
      toolName: call.name,
      pluginId: context.pluginId,
      runtimeId: context.runtimeId,
      input: call.arguments,
      output: result,
      durationMs: Date.now() - startTime,
      approvalStatus,
      createdAt: new Date().toISOString(),
    });
  } catch (recordErr) {
    console.warn(`[ToolExecutor] Failed to record tool call for ${call.name}:`, recordErr);
  }
}
