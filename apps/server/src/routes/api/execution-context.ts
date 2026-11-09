/**
 * What every execution entry point establishes before plugin code runs.
 *
 * Player turns, resumes, plugin RPC (actions, commands, runtimes and events),
 * background runtime jobs and the dimension-settlement retry each read the
 * live session under the session lock and refuse one that may not run, sync
 * the registry's activation view from it, snapshot the player's plugin
 * settings over the world's defaults, and build the session hook scope.
 * The rules for those steps live here, except the hook scope's, which
 * hooks fired outside an execution share (`session/hook-scope.ts`). Each
 * entry point keeps only what differs: how it reports a refusal, which lock
 * it holds and for how long, and its own approval checks.
 *
 * One exception to the lock: a background job is admitted from a read taken
 * without it, because a foreground turn may hold it for minutes. Its commit
 * re-reads the session under the lock and refuses one that may no longer run.
 */

import type { Context } from "hono";
import type { PluginRegistry } from "@covel/plugin-loader";
import { snapshotUserSettings } from "@covel/runtime";
import type { RuntimeManifest, TurnInput } from "@covel/shared";
import type { DataStore, SessionRecord } from "@covel/store";
import { withSettledSessionLock } from "./plugin-rpc/settled-request.js";
import type { SettleWaitBudget } from "./plugin-rpc/settled-session-lock.js";
import { loadSessionPluginUserSettings } from "./plugin-user-settings.js";
import { readLockedSession } from "./session/locked-mutation.js";

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
 * incarnation the request accepted, it is not being deleted, and it is
 * active.
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
    readonly signal?: AbortSignal;
  },
): Promise<SessionRecord | Response> {
  args.signal?.throwIfAborted();
  return readLockedSession({
    c,
    store: args.store,
    sessionId: args.sessionId,
    expectedSession: args.expectedSession,
    allowedStatuses: ["active"],
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
  if (live.status !== "active") throw new SessionNotActiveError(live.status);
  return live;
}

/**
 * Sync the registry's process-local activation view from a session read
 * under the lock, and return the runtimes active in it. Call it while
 * holding the session lock: the sync writes shared state, and a read taken
 * without the lock could resurrect a plugin a concurrent writer has just
 * disabled, until the next locked sync. Background job admission is the one
 * caller without the lock (see the module comment).
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
 * Re-read the session and sync the registry from it
 * ({@link syncSessionRuntimes}), under a session lock the caller holds.
 * Besides restart recovery, this drops activations another request or
 * server instance has removed. A session deleted meanwhile syncs to no
 * plugins, so a runtime lookup fails closed.
 */
async function syncLockedSessionRuntimes(
  c: Context,
  sessionId: string,
): Promise<readonly RuntimeManifest[]> {
  const live = await c.get("store").getSession(sessionId);
  return syncSessionRuntimes(
    c.get("pluginRegistry"),
    sessionId,
    live?.activePlugins ?? [],
  );
}

/**
 * Take the settled session lock briefly and sync the registry from the
 * session read under it ({@link syncLockedSessionRuntimes}). `stopSignal`
 * also ends the wait for the lock.
 */
export async function syncLiveSessionRuntimes(
  c: Context,
  sessionId: string,
  stopSignal?: AbortSignal,
): Promise<readonly RuntimeManifest[]> {
  return withSettledSessionLock(
    c,
    sessionId,
    () => syncLockedSessionRuntimes(c, sessionId),
    undefined,
    stopSignal,
  );
}

/**
 * Run `fn` under the settled session lock, with the registry synced from
 * the session read under it ({@link syncLockedSessionRuntimes}) and then
 * frozen: entry registrations, runtime artifacts and activations stay as
 * they were after the settle barrier for the whole of `fn`.
 */
export async function withSettledExecutionLock<T>(
  c: Context,
  sessionId: string,
  fn: () => Promise<T>,
  waitBudget?: SettleWaitBudget,
  stopSignal?: AbortSignal,
): Promise<T> {
  return withSettledSessionLock(
    c,
    sessionId,
    async () => {
      await syncLockedSessionRuntimes(c, sessionId);
      const snapshot = c.get("withPluginSnapshot");
      return snapshot ? snapshot(sessionId, fn) : fn();
    },
    waitBudget,
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
