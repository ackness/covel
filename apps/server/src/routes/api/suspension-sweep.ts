/**
 * Stale-suspension TTL sweep.
 *
 * Covel has no general scheduler, so expiry runs opportunistically — the
 * cutoff + cadence live ONLY here so every caller stays consistent:
 *   - a one-time forced sweep at server startup (bootstrap), and
 *   - a time-gated lazy sweep triggered by the suspension-touching routes
 *     (GET /:id/suspensions, POST /:id/resume) — mirroring the per-request
 *     lazy cleanup in `middleware/rate-limit.ts`.
 *
 * Only UNRESOLVED records older than the TTL are swept; claimed (in-flight)
 * and successfully-resolved suspensions are never touched — the predicate
 * lives in `store.deleteExpiredSuspensions`.
 */

import { readEnvInt } from "@covel/shared";
import type { DataStore } from "@covel/store";

/** Minimal store surface the sweep needs. */
type SuspensionSweepStore = Pick<DataStore, "deleteExpiredSuspensions">;

/** Default TTL: 7 days. */
const DEFAULT_TTL_MS = 604_800_000;

/** How often the opportunistic (non-forced) sweep may run. */
const SWEEP_INTERVAL_MS = 60 * 60_000; // 1 hour

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
}

/**
 * Sweep expired (unresolved, older-than-TTL) suspensions across all sessions.
 *
 * Time-gated to at most once per {@link SWEEP_INTERVAL_MS} unless `force` is
 * set. Best-effort: never throws into the caller (callers fire-and-forget).
 * Returns the number of records deleted (0 when skipped, disabled, or errored).
 */
export async function maybeSweepExpiredSuspensions(
  store: SuspensionSweepStore,
  opts: SweepOptions = {},
): Promise<number> {
  const ttlMs = resolveSuspensionTtlMs();
  if (ttlMs <= 0) return 0; // disabled escape hatch

  const now = opts.now ?? Date.now();
  if (!opts.force && now - lastSweepAt < SWEEP_INTERVAL_MS) return 0;
  lastSweepAt = now;

  try {
    const cutoff = new Date(now - ttlMs).toISOString();
    const deleted = await store.deleteExpiredSuspensions(cutoff);
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
