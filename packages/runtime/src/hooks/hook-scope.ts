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
}

const storage = new AsyncLocalStorage<HookScope>();

/** Run `fn` with the given active-plugin scope visible to the hook pipeline. */
export function runWithHookScope<T>(scope: HookScope, fn: () => T): T {
  return storage.run(scope, fn);
}

/** Active plugin ids for the current async context, or undefined if unscoped. */
export function currentActivePluginIds(): ReadonlySet<string> | undefined {
  return storage.getStore()?.activePluginIds;
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
