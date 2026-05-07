/**
 * Private helpers extracted from turn-executor.ts to keep it within the 1000-line budget.
 */

import type { RuntimeManifest, RuntimeResult, TurnInput } from "@covel/shared";
import type { ToolCallContext, ToolExecutor } from "./tool-executor.js";
import type { LLMToolDefinition } from "./llm-adapter.js";

/**
 * Build LLM tool definitions from a runtime's manifest declarations.
 * Looks up each declared tool in the ToolExecutor's registry to get its JSON schema.
 *
 * `context` is optional: when provided, the executor can surface session-
 * specific tool variants (e.g. `create-character` with schema-typed fields).
 */
export function buildToolDefinitions(
  manifest: RuntimeManifest,
  toolExecutor: ToolExecutor,
  context?: ToolCallContext,
): LLMToolDefinition[] | undefined {
  const names: string[] = [...(manifest.tools?.builtin ?? [])];

  // For local tools, extract name from path (e.g., ./tools/unlock-codex-entries.ts → unlock-codex-entries)
  for (const p of manifest.tools?.local ?? []) {
    names.push(
      p
        .split("/")
        .pop()
        ?.replace(/\.[^.]+$/, "") ?? p,
    );
  }

  // Framework-contracted tool: `runtime-done` is auto-available to tool-using
  // agent runtimes so the LLM can exit immediately after completing business
  // tool calls. Schema-declared runtimes must emit final JSON text, so
  // `runtime-done` is withheld there; otherwise the early-exit branch would
  // stop before the JSON envelope that downstream event chains read.
  if (!manifest.output?.schema && !names.includes("runtime-done")) {
    names.push("runtime-done");
  }

  if (names.length === 0) {
    return undefined;
  }

  const defs: LLMToolDefinition[] = [];

  for (const name of names) {
    const info = toolExecutor.getToolInfo(name, context);
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
        parameters: { type: "object" },
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
    status: "failed",
    output: null,
    toolCalls: [],
    durationMs: Date.now() - startTime,
    error,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Resolve the player-authored settings bucket for a runtime, merging the
 * per-key defaults declared in `manifest.userSettings` with the values the
 * player has saved (delivered by the caller via `TurnInput.userSettings`).
 *
 * Behaviour:
 *   - Returns `undefined` when the manifest declares no `userSettings` —
 *     callers should not put an empty `userSettings` field onto the handler
 *     ctx in that case (avoids lying about a feature the plugin never
 *     opted into).
 *   - Always includes every declared key: player value wins, default fills
 *     in missing keys. Handlers can therefore rely on
 *     `ctx.userSettings[spec.key]` being defined when the spec exists.
 *   - Scoped to the manifest's own `pluginId` — a runtime never sees
 *     another plugin's bucket.
 */
export function resolveUserSettings(
  manifest: RuntimeManifest,
  allUserSettings: TurnInput["userSettings"],
): Readonly<Record<string, unknown>> | undefined {
  const specs = manifest.userSettings;
  if (!specs || specs.length === 0) return undefined;

  const playerValues = allUserSettings?.[manifest.pluginId] ?? {};
  const merged: Record<string, unknown> = {};
  for (const spec of specs) {
    merged[spec.key] = Object.prototype.hasOwnProperty.call(
      playerValues,
      spec.key,
    )
      ? playerValues[spec.key]
      : spec.default;
  }
  return merged;
}
