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
 * request runs in its own async context).
 *
 * A missing scope is a programming error, never a default: firing hooks or
 * reading a plugin's settings outside one throws `MissingHookScopeError`.
 * Without a scope the pipeline could not tell which plugins are active, so it
 * would run every plugin's hooks for every session and hand handlers no
 * settings or locale. Any code path that fires hooks, commits proposals or
 * calls services outside an existing scope MUST wrap in `runWithHookScope`.
 * Current wrap sites (keep this list current when adding entry points):
 *   - runTurnPipeline / executeTurn — turn + LLM + tool hooks, compaction,
 *     services
 *   - resumeSuspendedRuntime — resumed runtime, its hooks and services
 *   - finalizeExecution — commit (Pre/PostStateCommit)
 *   - server session routes — SessionStart / SessionEnd
 *   - server resume route — resume exec + its commit
 *   - server characters route — direct character.upsert commit
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface HookScope {
  /** One player input across its continuation rounds. */
  readonly logicalKey?: string;
  readonly logicalTurn?: number;
  /** Plugin ids active in the current session. */
  readonly activePluginIds: ReadonlySet<string>;
  /**
   * Per-plugin, read-only `userSettings` snapshot for this operation, keyed by
   * `pluginId`. Each bucket is the plugin's resolved settings (manifest
   * defaults merged with world and player values), already frozen. Production
   * entry points capture this before execution or lifecycle mutation and pass
   * it through commit. A scope without settings gives every plugin `{}`.
   * Nested scopes never inherit another operation's settings.
   */
  readonly settings?: Readonly<
    Record<string, Readonly<Record<string, unknown>>>
  >;
  /**
   * The session's content locale, fixed when the session was created. Every
   * production entry point sets it; the pipeline hands it to each handler as
   * `HookContext.locale`.
   */
  readonly locale?: string;
}

/**
 * Thrown when hooks fire, or a plugin's settings are read, with no session
 * hook scope in the async context. It always means an entry point forgot to
 * wrap its work in `runWithHookScope`.
 */
export class MissingHookScopeError extends Error {
  override readonly name = "MissingHookScopeError";
  readonly operation: string;

  constructor(operation: string) {
    super(
      `${operation} ran outside a session hook scope. ` +
        "Wrap the entry point in runWithHookScope() with the session's " +
        "active plugins, settings and locale; without one the kernel cannot " +
        "tell which plugins' hooks may run or which settings they read.",
    );
    this.operation = operation;
  }
}

const storage = new AsyncLocalStorage<HookScope>();

/** Shared frozen empty bucket — returned whenever a plugin has no settings. */
const EMPTY_SETTINGS: Readonly<Record<string, unknown>> = Object.freeze({});

/** Run `fn` with the given active-plugin scope visible to the hook pipeline. */
export function runWithHookScope<T>(scope: HookScope, fn: () => T): T {
  return storage.run(
    { ...scope, activePluginIds: new Set(scope.activePluginIds) },
    fn,
  );
}

/**
 * The hook scope of the current async context. Throws
 * `MissingHookScopeError` naming `operation` when there is none.
 */
export function requireHookScope(operation: string): HookScope {
  const scope = storage.getStore();
  if (!scope) throw new MissingHookScopeError(operation);
  return scope;
}

/**
 * One plugin's resolved settings from `scope`: a frozen, read-only bucket, or
 * the shared empty bucket when `pluginId` is undefined (framework / global
 * hook) or the scope carries none for it. It never exposes another plugin's
 * bucket — callers pass only their own `pluginId`.
 */
export function scopedOwnSettings(
  scope: Pick<HookScope, "settings">,
  pluginId: string | undefined,
): Readonly<Record<string, unknown>> {
  if (!pluginId || !scope.settings || !Object.hasOwn(scope.settings, pluginId))
    return EMPTY_SETTINGS;
  return scope.settings[pluginId] ?? EMPTY_SETTINGS;
}

/**
 * Read the current operation's resolved settings for a single plugin; the data
 * source behind `getOwnSettings` in hook and service contexts. Throws
 * `MissingHookScopeError` outside a scope instead of answering `{}`, which
 * would silently drop the player's settings.
 */
export function currentOwnSettings(
  pluginId: string | undefined,
): Readonly<Record<string, unknown>> {
  return scopedOwnSettings(requireHookScope("getOwnSettings()"), pluginId);
}

/**
 * Whether a hook registration is eligible to run under `active`. Framework
 * hooks (no `pluginId`) always run; plugin hooks run only when their plugin
 * is in the active set.
 */
export function isHookInScope(
  pluginId: string | undefined,
  active: ReadonlySet<string>,
): boolean {
  return pluginId === undefined || active.has(pluginId);
}
