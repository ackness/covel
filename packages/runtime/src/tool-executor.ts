/**
 * ToolExecutor — resolves, validates, and executes tool calls from LLM responses.
 *
 * Pipeline per call:
 *   1. Look up tool in ToolRegistry by name
 *   2. Parse arguments JSON
 *   3. Execute tool.execute(params, context)
 *   4. Record call to DataStore (if available)
 *   5. Return result string for LLM
 */

import type { ToolModule } from '@covel/tools';
import type { DataStore } from '@covel/store';

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
}

export interface ToolCallResult {
  readonly toolCallId: string;
  readonly name: string;
  readonly result: string;  // JSON string for LLM
  readonly parsedResult: unknown; // Parsed result for framework use
  readonly success: boolean;
}

export interface ToolInfo {
  readonly name: string;
  readonly description: string;
  readonly jsonSchema: Readonly<Record<string, unknown>>;
}

export interface ToolExecutor {
  execute(call: ToolCall, context: ToolCallContext): Promise<ToolCallResult>;
  getToolInfo(name: string): ToolInfo | undefined;
}

// ── Implementation ───────────────────────────────────────────────

export interface ToolExecutorConfig {
  /** Tool lookup function — returns the tool module by name. */
  readonly findTool: (name: string) => ToolModule | undefined;
  /** Optional DataStore for recording tool calls. */
  readonly store?: DataStore;
}

export function createToolExecutor(config: ToolExecutorConfig): ToolExecutor {
  return {
    getToolInfo(name: string): ToolInfo | undefined {
      const tool = config.findTool(name);
      if (!tool) return undefined;
      return { name: tool.name, description: tool.description, jsonSchema: tool.jsonSchema as Record<string, unknown> };
    },

    async execute(call: ToolCall, context: ToolCallContext): Promise<ToolCallResult> {
      const startTime = Date.now();

      // 1. Find tool
      const tool = config.findTool(call.name);
      if (!tool) {
        const errorResult = JSON.stringify({ error: `Unknown tool: ${call.name}` });
        await recordCall(config.store, call, context, errorResult, startTime, false);
        return { toolCallId: call.toolCallId, name: call.name, result: errorResult, parsedResult: null, success: false };
      }

      // 2. Parse arguments
      let params: unknown;
      try {
        params = JSON.parse(call.arguments);
      } catch {
        const errorResult = JSON.stringify({ error: `Invalid JSON arguments for ${call.name}` });
        await recordCall(config.store, call, context, errorResult, startTime, false);
        return { toolCallId: call.toolCallId, name: call.name, result: errorResult, parsedResult: null, success: false };
      }

      // 3. Execute
      try {
        const execContext = {
          sessionId: context.sessionId,
          turnId: context.turnId,
          pluginId: context.pluginId,
          runtimeId: context.runtimeId,
        };
        const rawResult = await tool.execute(params, execContext);
        const resultStr = JSON.stringify(rawResult);

        await recordCall(config.store, call, context, resultStr, startTime, true);
        return { toolCallId: call.toolCallId, name: call.name, result: resultStr, parsedResult: rawResult, success: true };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const errorResult = JSON.stringify({ error: message });
        await recordCall(config.store, call, context, errorResult, startTime, false);
        return { toolCallId: call.toolCallId, name: call.name, result: errorResult, parsedResult: null, success: false };
      }
    },
  };
}

async function recordCall(
  store: DataStore | undefined,
  call: ToolCall,
  context: ToolCallContext,
  result: string,
  startTime: number,
  success: boolean,
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
      approvalStatus: 'auto-allowed',
      createdAt: new Date().toISOString(),
    });
  } catch (recordErr) {
    console.warn(`[ToolExecutor] Failed to record tool call for ${call.name}:`, recordErr);
  }
}
