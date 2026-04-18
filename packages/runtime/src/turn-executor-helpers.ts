/**
 * Private helpers extracted from turn-executor.ts to keep it within the 1000-line budget.
 */

import type { RuntimeManifest, RuntimeResult, TurnInput } from '@covel/shared';
import type { ToolExecutor } from './tool-executor.js';
import type { LLMToolDefinition } from './llm-adapter.js';

/**
 * Build LLM tool definitions from a runtime's manifest declarations.
 * Looks up each declared tool in the ToolExecutor's registry to get its JSON schema.
 */
export function buildToolDefinitions(
  manifest: RuntimeManifest,
  toolExecutor: ToolExecutor,
): LLMToolDefinition[] | undefined {
  const names: string[] = [...(manifest.tools?.builtin ?? [])];

  // For local tools, extract name from path (e.g., ./tools/unlock-codex-entries.ts → unlock-codex-entries)
  for (const p of manifest.tools?.local ?? []) {
    names.push(p.split('/').pop()?.replace(/\.[^.]+$/, '') ?? p);
  }

  // Framework-contracted tool: `runtime-done` is auto-available to every
  // agent runtime so the LLM can exit immediately after completing its
  // business tool calls. See packages/tools/src/builtin/runtime-done.ts
  // and the early-exit branch in turn-executor.ts. This is intentionally
  // NOT declared in PLUGIN.md — it's a framework-level capability.
  if (!names.includes('runtime-done')) {
    names.push('runtime-done');
  }

  if (names.length === 0) {
    return undefined;
  }

  const defs: LLMToolDefinition[] = [];

  for (const name of names) {
    const info = toolExecutor.getToolInfo(name);
    if (info) {
      defs.push({
        name: info.name,
        description: info.description,
        parameters: info.jsonSchema as Record<string, unknown>,
      });
    } else {
      // Tool not found in registry — add a minimal definition so LLM knows it exists
      defs.push({
        name,
        description: `Tool: ${name}`,
        parameters: { type: 'object' },
      });
    }
  }

  return defs.length > 0 ? defs : undefined;
}

export function makeFailedResult(
  manifest: RuntimeManifest,
  input: TurnInput,
  runId: string,
  startTime: number,
  error: string,
): RuntimeResult {
  return {
    pluginId: manifest.pluginId,
    runtimeId: manifest.name,
    runId,
    turnId: input.turnId,
    status: 'failed',
    output: null,
    toolCalls: [],
    durationMs: Date.now() - startTime,
    error,
    timestamp: new Date().toISOString(),
  };
}
