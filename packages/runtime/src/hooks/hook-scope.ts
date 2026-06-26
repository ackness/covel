/**
 * Session-scoped hook execution.
 *
 * The HookPipeline is a single global instance (all plugins' hooks registered
 * once at bootstrap). To honour session plugin scope — a hook from plugin X
 * must only fire for sessions where X is active — the active plugin set is
 * published into an AsyncLocalStorage for the duration of a turn (executeTurn)
 * or a session-lifecycle route, and the pipeline filters handlers against it.
 *
 * Why ALS instead of threading the set through every call site: there are ~11
 * hook sites across the turn/commit/resume paths; ALS scopes them all without
 * touching each signature, and is race-safe across concurrent sessions (each
 * request runs in its own async context). When no scope is set (e.g. unit
 * tests calling pipeline.run directly), filtering is a no-op.
 *
 * CONSTRAINT: any code path that fires hooks or commits proposals outside an
 * existing scope MUST wrap in `runWithHookScope`, else those hooks run
 * unfiltered. Current wrap sites (keep this list current when adding entry
 * points):
 *   - executeTurn (turn pipeline) — turn + LLM + tool hooks, compaction
 *   - server session routes — SessionStart / SessionEnd
 *   - createRuntimeResultProcessor.process — commit (Pre/PostStateCommit)
 *   - resume route — resume exec + its commit
 *   - characters route — direct character.upsert commit
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface HookScope {
  /** Plugin ids active in the current session. */
  readonly activePluginIds: ReadonlySet<string>;
  /**
   * Per-plugin, read-only `userSettings` snapshot for this turn, keyed by
   * `pluginId`. Each bucket is the plugin's resolved settings (manifest
   * defaults merged with the player's saved values), already frozen. The turn
   * pipeline populates this; other scope sites (session / resume / commit /
   * characters) omit it, in which case `getOwnSettings` degrades to `{}`.
   */
  readonly settings?: Readonly<
    Record<string, Readonly<Record<string, unknown>>>
  >;
}

const storage = new AsyncLocalStorage<HookScope>();

/** Shared frozen empty bucket — returned whenever a plugin has no settings. */
const EMPTY_SETTINGS: Readonly<Record<string, unknown>> = Object.freeze({});

/** Run `fn` with the given active-plugin scope visible to the hook pipeline. */
export function runWithHookScope<T>(scope: HookScope, fn: () => T): T {
  return storage.run(scope, fn);
}

/** Active plugin ids for the current async context, or undefined if unscoped. */
export function currentActivePluginIds(): ReadonlySet<string> | undefined {
  return storage.getStore()?.activePluginIds;
}

/** Whether a hook scope is active in the current async context. */
export function isHookScopeActive(): boolean {
  return storage.getStore() !== undefined;
}

/**
 * Read the current turn's resolved settings for a single plugin.
 *
 * Returns a frozen, read-only bucket. Returns the shared empty bucket when:
 * - there is no active scope,
 * - `pluginId` is undefined (framework / global hook), or
 * - the scope carries no settings, or the plugin declared / saved none.
 *
 * This is the data source behind `HookContext.getOwnSettings`. It never
 * exposes another plugin's bucket — callers pass only their own `pluginId`.
 */
export function currentOwnSettings(
  pluginId: string | undefined,
): Readonly<Record<string, unknown>> {
  if (!pluginId) return EMPTY_SETTINGS;
  const settings = storage.getStore()?.settings;
  return settings?.[pluginId] ?? EMPTY_SETTINGS;
}

/**
 * Whether a hook registration is eligible to run under the current scope.
 * Framework hooks (no `pluginId`) always run; plugin hooks run only when their
 * plugin is in the active set. No active scope → no filtering (run all).
 */
export function isHookInScope(
  pluginId: string | undefined,
  active: ReadonlySet<string> | undefined,
): boolean {
  if (pluginId === undefined || active === undefined) return true;
  return active.has(pluginId);
}
