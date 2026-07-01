/**
 * Private helpers extracted from turn-executor.ts to keep it within the 1000-line budget.
 */

import type {
  PluginUserSettingSpec,
  RuntimeManifest,
  RuntimeResult,
  TurnInput,
} from "@covel/shared";
import type {
  ToolCallContext,
  ToolExecutor,
} from "../agent-loop/tool-executor.js";
import type { LLMToolDefinition } from "../llm/llm-adapter.js";
import { isPreGamePriority } from "../schedule/scheduler.js";

/**
 * Force-retain Pre-Game runtimes a PreSchedule hook tried to drop.
 *
 * A `PreSchedule` handler may narrow the per-turn runtime set, but it must not
 * be able to remove Pre-Game runtimes (priority ≤ 99) while Pre-Game is still
 * pending — dropping `pregame` / `schema-gen` / `player-init` would silently
 * break session initialization. Any triggered Pre-Game runtime missing from
 * `scheduled` is appended back (scheduling re-sorts the Pre-Game band by
 * priority, so append order is irrelevant). Emits a dev warning naming the
 * runtimes it rescued. Pure; safe to unit-test directly.
 *
 * The Pre-Game band test (`isPreGamePriority`) is shared with
 * `getPreGameRuntimeState` in session-state.ts — the single source of truth
 * for what counts as Pre-Game. A runtime that omits `priority`
 * is, by that definition, NOT a Pre-Game runtime: it never gates Pre-Game
 * completion (`isPreGamePending` ignores it too), so it is intentionally not
 * rescued here. Rescuing it would diverge from the gate and could pin a
 * non-Pre-Game runtime a hook deliberately dropped.
 */
export function retainPreGameRuntimes(
  scheduled: readonly RuntimeManifest[],
  triggered: readonly RuntimeManifest[],
): readonly RuntimeManifest[] {
  const present = new Set(scheduled.map((r) => r.name));
  // Same Pre-Game predicate as getPreGameRuntimeState — see JSDoc above.
  const droppedPreGame = triggered.filter(
    (r) => isPreGamePriority(r.priority) && !present.has(r.name),
  );
  if (droppedPreGame.length === 0) return scheduled;
  console.warn(
    `[PreSchedule] force-retaining Pre-Game runtime(s) a hook tried to drop ` +
      `while Pre-Game is pending: ${droppedPreGame.map((r) => r.name).join(", ")}`,
  );
  return [...scheduled, ...droppedPreGame];
}

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
  overrides?: {
    /** Preserve runtime output (diagnostics, partial envelope). Defaults to null. */
    readonly output?: RuntimeResult["output"];
    /** Preserve collected tool calls. Defaults to []. */
    readonly toolCalls?: RuntimeResult["toolCalls"];
  },
): RuntimeResult {
  return {
    pluginId: manifest.pluginId,
    runtimeId: manifest.name,
    runId,
    turnId: input.turnId,
    status: "failed",
    output: overrides?.output ?? null,
    toolCalls: overrides?.toolCalls ?? [],
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
/**
 * Validate a candidate value against a userSettings spec's declared constraints
 * (type / min / max / options). The front-end SettingsStore enforces these when
 * a player edits a value, but world-authored `pluginSettings` and a raw
 * `X-Plugin-User-Settings` header reach the server WITHOUT that check — so an
 * out-of-range / wrong-type value (`dialogueRatio: "lots"`, `999`) could
 * otherwise flow into `{{ userSettings.* }}`, guards, and numeric hook
 * comparisons. Invalid values fall back to the manifest default here.
 */
function isValidForSpec(value: unknown, spec: PluginUserSettingSpec): boolean {
  switch (spec.type) {
    case "number":
    case "integer":
    case "slider":
      if (typeof value !== "number" || !Number.isFinite(value)) return false;
      if (spec.type === "integer" && !Number.isInteger(value)) return false;
      if (typeof spec.min === "number" && value < spec.min) return false;
      if (typeof spec.max === "number" && value > spec.max) return false;
      return true;
    case "toggle":
      return typeof value === "boolean";
    case "select":
      return (
        typeof value === "string" &&
        (!spec.options ||
          spec.options.length === 0 ||
          spec.options.some((o) => o.value === value))
      );
    case "text":
    case "textarea":
      return typeof value === "string";
    default:
      return true;
  }
}

export function resolveUserSettings(
  manifest: RuntimeManifest,
  allUserSettings: TurnInput["userSettings"],
): Readonly<Record<string, unknown>> | undefined {
  const specs = manifest.userSettings;
  if (!specs || specs.length === 0) return undefined;

  const playerValues = allUserSettings?.[manifest.pluginId] ?? {};
  const merged: Record<string, unknown> = {};
  for (const spec of specs) {
    const hasValue = Object.prototype.hasOwnProperty.call(
      playerValues,
      spec.key,
    );
    const candidate = hasValue ? playerValues[spec.key] : spec.default;
    // Enforce declared constraints on the (untrusted) merged value; an invalid
    // world/header value degrades to the manifest default rather than reaching
    // the runtime. spec.default itself is author-trusted and not re-checked.
    merged[spec.key] =
      hasValue && candidate !== undefined && !isValidForSpec(candidate, spec)
        ? spec.default
        : candidate;
  }
  return merged;
}
