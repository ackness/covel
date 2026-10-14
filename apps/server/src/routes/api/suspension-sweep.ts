/**
 * Stale-suspension TTL sweep.
 *
 * Covel has no general scheduler, so expiry runs opportunistically — the
 * cutoff + cadence live ONLY here so every caller stays consistent:
 *   - a one-time forced sweep at server startup (bootstrap), and
 *   - a time-gated lazy sweep triggered by the suspension-touching routes
 *     (GET /:id/suspensions, POST /:id/suspensions/:suspensionId/resume) — mirroring the per-request
 *     lazy cleanup in `middleware/rate-limit.ts`.
 *
 * Only UNRESOLVED records older than the TTL are swept; claimed (in-flight)
 * and successfully-resolved suspensions are never touched — the predicate
 * lives in `store.listExpiredSuspensions`. Each expired record is abandoned
 * under its session lock the way `DELETE /suspensions/:id` abandons one
 * (`suspension-abandon.ts`): the turn it held back is counted and its
 * detached jobs are queued when it was the turn's last pending suspension.
 *
 * The same pass releases a claim whose process ended before it settled the
 * resume, so the player can resume or abandon the suspension again. Like a
 * resume that failed, this does not undo an external call the run had made.
 */

import type { Context } from "hono";
import { readEnvInt } from "@covel/shared";
import type { DataStore, SuspensionRecord } from "@covel/store";
import type { SessionLock } from "../../lib/session-lock.js";
import {
  abandonSuspension,
  type SuspensionAbandonDeps,
} from "./suspension-abandon.js";

/** What the sweep needs. */
export interface SuspensionSweepDeps {
  readonly store: Pick<
    DataStore,
    "listExpiredSuspensions" | "releaseStaleSuspensionClaims"
  >;
  /**
   * Abandon one expired suspension under its session lock when it is still
   * unresolved and older than `cutoff`. Returns whether it did.
   */
  readonly expire: (
    suspension: SuspensionRecord,
    cutoff: string,
  ) => Promise<boolean>;
}

/**
 * The sweep's `expire`: re-read the record under the session lock and abandon
 * it. It carries no request credentials or player settings, because one sweep
 * covers every session; a released job gets credentials from the session's
 * next request.
 */
export function suspensionExpirer(
  deps: SuspensionAbandonDeps & { readonly sessionLock: SessionLock },
): SuspensionSweepDeps["expire"] {
  return (suspension, cutoff) =>
    deps.sessionLock.withLock(suspension.sessionId, async () => {
      const live = await deps.store.getSuspension(suspension.id);
      if (
        !live ||
        live.sessionId !== suspension.sessionId ||
        live.resolvedAt !== undefined ||
        !(live.createdAt < cutoff)
      )
        return false;
      await abandonSuspension(deps, live);
      return true;
    });
}

/** The sweep dependencies of a request: no credentials, every session. */
export function requestSuspensionSweepDeps(c: Context): SuspensionSweepDeps {
  const store = c.get("store");
  const eventBus = c.get("eventBus");
  const worker = c.get("runtimeJobWorker");
  return {
    store,
    expire: suspensionExpirer({
      store,
      pluginRegistry: c.get("pluginRegistry"),
      sessionLock: c.get("sessionLock"),
      ...(eventBus ? { eventBus } : {}),
      ...(worker ? { worker } : {}),
    }),
  };
}

/** Default TTL: 7 days. */
const DEFAULT_TTL_MS = 604_800_000;

/** How often the opportunistic (non-forced) sweep may run. */
const SWEEP_INTERVAL_MS = 60 * 60_000; // 1 hour

/** A claim older than this has no live resume behind it. */
const CLAIM_MAX_AGE_MS = 60 * 60_000;

let lastSweepAt = 0;

/** Resolve the configured TTL (ms). `<= 0` disables sweeping entirely. */
export function resolveSuspensionTtlMs(): number {
  return readEnvInt("COVEL_SUSPENSION_TTL_MS", DEFAULT_TTL_MS);
}

export interface SweepOptions {
  /** Bypass the interval gate (used by the startup sweep). */
  readonly force?: boolean;
  /** Injectable clock for deterministic tests. */
  readonly now?: number;
  /**
   * Age after which a claim is released. Pass 0 at the start of the only
   * process that uses the store: no claim it finds can be live.
   */
  readonly claimMaxAgeMs?: number;
}

/**
 * Sweep expired (unresolved, older-than-TTL) suspensions across all sessions.
 *
 * Time-gated to at most once per {@link SWEEP_INTERVAL_MS} unless `force` is
 * set. Best-effort: never throws into the caller (callers fire-and-forget).
 * Returns the number of records abandoned (0 when skipped, disabled, or errored).
 */
export async function maybeSweepExpiredSuspensions(
  deps: SuspensionSweepDeps,
  opts: SweepOptions = {},
): Promise<number> {
  const { store } = deps;
  const ttlMs = resolveSuspensionTtlMs();

  const now = opts.now ?? Date.now();
  if (!opts.force && now - lastSweepAt < SWEEP_INTERVAL_MS) return 0;
  lastSweepAt = now;

  try {
    const released = await store.releaseStaleSuspensionClaims(
      new Date(now - (opts.claimMaxAgeMs ?? CLAIM_MAX_AGE_MS)).toISOString(),
    );
    if (released > 0) {
      console.warn(
        `[suspension-sweep] released ${released} claim(s) left by an ended resume`,
      );
    }
    if (ttlMs <= 0) return 0; // expiry is off; a dead claim is still released
    const cutoff = new Date(now - ttlMs).toISOString();
    let deleted = 0;
    for (const suspension of await store.listExpiredSuspensions(cutoff)) {
      // One record that cannot be settled must not keep the rest alive.
      try {
        if (await deps.expire(suspension, cutoff)) deleted += 1;
      } catch (err) {
        console.warn(
          `[suspension-sweep] could not expire suspension ${suspension.id}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    if (deleted > 0) {
      console.warn(
        `[suspension-sweep] expired ${deleted} stale suspension(s) older than ${cutoff}`,
      );
    }
    return deleted;
  } catch (err) {
    // Best-effort maintenance — log and swallow, never break a request or boot.
    console.warn(
      "[suspension-sweep] sweep failed:",
      err instanceof Error ? err.message : String(err),
    );
    return 0;
  }
}

/** Test-only: reset the module-level interval clock. */
export function __resetSweepClockForTests(): void {
  lastSweepAt = 0;
}
