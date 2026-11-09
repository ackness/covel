/**
 * What every execution entry point establishes before plugin code runs.
 *
 * Player turns, resumes, plugin RPC (actions, commands, runtimes and events),
 * background runtime jobs and the dimension-settlement retry each read the
 * live session under the session lock and refuse one that may not run, sync
 * the registry's activation view from it, snapshot the player's plugin
 * settings over the world's defaults, and build the session hook scope.
 * The rules for those steps live here. Each entry point keeps only what
 * differs: how it reports a refusal, which lock it holds and for how long,
 * and its own approval checks.
 */

import type { Context } from "hono";
import type { PluginRegistry } from "@covel/plugin-loader";
import { snapshotUserSettings, type HookScope } from "@covel/runtime";
import type { RuntimeManifest, TurnInput } from "@covel/shared";
import type { DataStore, SessionRecord } from "@covel/store";
import { withSettledSessionLock } from "./plugin-rpc/settled-request.js";
import { loadSessionPluginUserSettings } from "./plugin-user-settings.js";
import { buildSessionHookScope } from "./session/hook-scope.js";
import { readLockedSession } from "./session/locked-mutation.js";

/** The session statuses an execution may run in. */
export const EXECUTION_SESSION_STATUSES: readonly string[] = ["active"];

/** A request-free execution found its session deleted or no longer active. */
export class SessionNotActiveError extends Error {
  constructor(readonly status: string) {
    super(`session is ${status}; runtime execution refused`);
    this.name = "SessionNotActiveError";
  }
}

/**
 * The session as read under the lock a request holds, or the refusal to
 * return. Refused unless it still exists, the caller owns it, it is the
 * incarnation the request accepted, it is not being deleted, and its status
 * is allowed (`["active"]` unless the caller says otherwise).
 *
 * `signal` is checked before the read: an aborted one (the server shutting
 * down) throws instead of starting the execution.
 */
export async function readExecutionSession(
  c: Context,
  args: {
    readonly store: DataStore;
    readonly sessionId: string;
    /** The session the request accepted before it waited for the lock. */
    readonly expectedSession: SessionRecord;
    readonly allowedStatuses?: readonly string[];
    readonly signal?: AbortSignal;
  },
): Promise<SessionRecord | Response> {
  args.signal?.throwIfAborted();
  return readLockedSession({
    c,
    store: args.store,
    sessionId: args.sessionId,
    expectedSession: args.expectedSession,
    allowedStatuses: args.allowedStatuses ?? EXECUTION_SESSION_STATUSES,
  });
}

/**
 * The live session for work that runs without a request (background runs
 * and their commits), read under the session lock. Throws
 * `SessionNotActiveError` when it was deleted or is no longer active.
 */
export async function requireActiveSession(
  store: Pick<DataStore, "getSession">,
  sessionId: string,
): Promise<SessionRecord> {
  const live = await store.getSession(sessionId);
  if (!live) throw new SessionNotActiveError("deleted");
  if (!EXECUTION_SESSION_STATUSES.includes(live.status))
    throw new SessionNotActiveError(live.status);
  return live;
}

/**
 * Sync the registry's process-local activation view from a session read
 * under the lock, and return the runtimes active in it. Call it while
 * holding the session lock: the sync writes shared state, and a read taken
 * without the lock could resurrect a plugin a concurrent writer has just
 * disabled.
 */
export function syncSessionRuntimes(
  registry: Pick<
    PluginRegistry,
    "syncSessionActivations" | "getActiveRuntimes"
  >,
  sessionId: string,
  activePlugins: readonly string[],
): readonly RuntimeManifest[] {
  registry.syncSessionActivations(sessionId, activePlugins);
  return registry.getActiveRuntimes(sessionId);
}

/**
 * Take the settled session lock briefly, re-read the session and sync the
 * registry from it ({@link syncSessionRuntimes}). Besides restart recovery,
 * this drops activations another request or server instance has removed. A
 * session deleted meanwhile syncs to no plugins, so a runtime lookup fails
 * closed. `stopSignal` also ends the wait for the lock.
 */
export async function syncLiveSessionRuntimes(
  c: Context,
  sessionId: string,
  stopSignal?: AbortSignal,
): Promise<readonly RuntimeManifest[]> {
  return withSettledSessionLock(
    c,
    sessionId,
    async () => {
      const live = await c.get("store").getSession(sessionId);
      return syncSessionRuntimes(
        c.get("pluginRegistry"),
        sessionId,
        live?.activePlugins ?? [],
      );
    },
    undefined,
    stopSignal,
  );
}

/**
 * The plugin settings an execution runs with: the world's authored defaults
 * (`WorldRecord.metadata.pluginSettings`) under the player's request
 * settings, deep-frozen so the execution and its hooks share one snapshot.
 * The runtime fills a key still missing from the manifest default.
 */
export async function loadExecutionUserSettings(
  store: Pick<DataStore, "getWorld">,
  session: Pick<SessionRecord, "worldId">,
  playerSettings: TurnInput["userSettings"],
): Promise<TurnInput["userSettings"]> {
  return snapshotUserSettings(
    await loadSessionPluginUserSettings(store, session, playerSettings),
  );
}

/**
 * The hook scope of an execution in `session`: the hooks of its runnable
 * plugins, each plugin's settings, and the session's content locale, which
 * every hook receives as `ctx.locale`.
 */
export function executionHookScope(args: {
  readonly pluginRegistry: Pick<PluginRegistry, "get" | "getAll"> | undefined;
  readonly session: Pick<SessionRecord, "activePlugins" | "locale">;
  readonly userSettings: TurnInput["userSettings"];
}): HookScope {
  return buildSessionHookScope({
    pluginRegistry: args.pluginRegistry,
    activePluginIds: args.session.activePlugins,
    userSettings: args.userSettings,
    locale: args.session.locale,
  });
}
