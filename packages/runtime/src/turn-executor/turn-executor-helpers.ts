import { isValidPluginSetting } from "@covel/shared";
/**
 * Private helpers extracted from turn-executor.ts to keep it within the 1000-line budget.
 */

import type { RuntimeManifest, RuntimeResult, TurnInput } from "@covel/shared";
import { isSetupRuntime } from "@covel/shared";
import type { EffectiveAgentOutput } from "@covel/shared/plugin-runtime";
import { outputToolDefinition } from "../agent-loop/agent-output-contract.js";
import { DELEGATE_TOOL_NAME, DELEGATE_BATCH_TOOL_NAME } from "@covel/tools";
import type {
  ToolCallContext,
  ToolExecutor,
} from "../agent-loop/tool-executor.js";
import type { LLMToolDefinition } from "@covel/shared";
import {
  buildSearchToolsDefinition,
  declaredToolNames,
  resolveDeferredToolNames,
} from "../agent-loop/tool-search.js";
import { generatedToolNames } from "../agent-loop/agent-tool-surface.js";

/**
 * Force-retain Pre-Game runtimes a PreSchedule hook tried to drop.
 *
 * A `PreSchedule` handler may narrow the per-turn runtime set, but it must not
 * be able to remove setup-stage runtimes while setup is still pending —
 * dropping `pregame` / `schema-gen` / `player-init` would silently break
 * session initialization. Any triggered setup runtime missing from `scheduled`
 * is appended back (scheduling re-orders the setup stage by its declared edges,
 * so append order is irrelevant). Emits a dev warning naming the runtimes it
 * rescued. Pure; safe to unit-test directly.
 *
 * The setup-stage test (`isSetupRuntime`) is shared with
 * `getPreGameRuntimeState` in session-state.ts — the single source of truth
 * for what counts as a setup runtime. A stage-less runtime is, by that
 * definition, NOT a setup runtime: it never gates setup completion, so it is
 * intentionally not rescued here.
 */
export function retainPreGameRuntimes(
  scheduled: readonly RuntimeManifest[],
  triggered: readonly RuntimeManifest[],
): readonly RuntimeManifest[] {
  const present = new Set(scheduled.map((r) => r.name));
  // Same setup predicate as getPreGameRuntimeState — see JSDoc above.
  const droppedPreGame = triggered.filter(
    (r) => isSetupRuntime(r) && !present.has(r.name),
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
 * The required context lets the executor surface session-specific tool
 * variants and enforce plugin scoping while resolving schemas.
 */
export async function buildToolDefinitions(
  manifest: RuntimeManifest,
  toolExecutor: ToolExecutor | undefined,
  context: ToolCallContext,
  output: EffectiveAgentOutput,
): Promise<LLMToolDefinition[]> {
  for (const name of [
    ...(manifest.tools?.builtin ?? []),
    ...(manifest.tools?.plugin ?? []),
    ...generatedToolNames(manifest),
    ...(Array.isArray(manifest.tools?.defer) ? manifest.tools.defer : []),
  ]) {
    if (name === output.toolName)
      throw new Error(
        `runtime "${manifest.name}": submit-output is reserved; do not declare or defer it`,
      );
  }
  for (const name of manifest.tools?.plugin ?? []) {
    if (!toolExecutor?.getToolInfo(name, context))
      throw new Error(
        `runtime "${manifest.name}" declares plugin tool "${name}", but its plugin did not register it`,
      );
  }
  // Manifest validation keeps generated names apart from declared ones.
  const generated = new Set(generatedToolNames(manifest));
  for (const name of [
    ...(manifest.tools?.builtin ?? []),
    ...(manifest.tools?.plugin ?? []),
  ])
    if (generated.has(name))
      throw new Error(
        `runtime "${manifest.name}" generates tool "${name}", a name it also declares`,
      );
  // Deferred tools (tools.defer) are registered and authorized but withheld
  // from the initial advertisement — the LLM discovers them through the
  // injected `search-tools` tool (see agent-loop/tool-search.ts).
  const deferred = resolveDeferredToolNames(manifest);
  const names = declaredToolNames(manifest).filter(
    (name) => !deferred.has(name),
  );

  const defs: LLMToolDefinition[] = [];

  for (const name of names) {
    const info = toolExecutor?.getToolInfo(name, context);
    if (info) {
      defs.push({
        name: info.name,
        description: info.description,
        parameters: info.jsonSchema as Record<string, unknown>,
      });
    } else if (
      generated.has(name) ||
      [DELEGATE_TOOL_NAME, DELEGATE_BATCH_TOOL_NAME].includes(name)
    ) {
      // Optional imports and delegation targets can be absent for this run.
    } else {
      // Missing builtins are optional host capabilities.
      console.warn(
        `[turn-executor] runtime "${manifest.name}": builtin tool "${name}" ` +
          `is not installed on this host — not offered`,
      );
    }
  }

  if (deferred.size > 0) {
    defs.push(buildSearchToolsDefinition(deferred.size, manifest.pluginId));
  }

  defs.push(await outputToolDefinition(output, context.locale));
  return defs;
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
 * Build a framework `skipped` result (the shape the upstream gate emits). `by`
 * names the framework gate (`framework:dependencyCycle`, `framework:setupGate`)
 * and `detail` carries gate-specific diagnostics (e.g. the full cycle path).
 */
export function makeSkippedResult(
  manifest: RuntimeManifest,
  input: Pick<TurnInput, "turnId">,
  reason: string,
  by: string,
  detail?: Record<string, unknown>,
): RuntimeResult {
  return {
    pluginId: manifest.pluginId,
    runtimeId: manifest.name,
    runId: crypto.randomUUID(),
    turnId: input.turnId,
    status: "skipped",
    output: { skipped: true, reason, skippedBy: by, ...detail },
    toolCalls: [],
    durationMs: 0,
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

export function resolveUserSettings(
  manifest: Pick<RuntimeManifest, "pluginId" | "userSettings">,
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
      hasValue &&
      candidate !== undefined &&
      !isValidPluginSetting(candidate, spec)
        ? spec.default
        : candidate;
  }
  return merged;
}
