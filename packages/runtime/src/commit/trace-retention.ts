/**
 * Trace retention sweep across all sessions.
 *
 * A commit prunes only the session that just committed, so the traces of a
 * session nobody plays again would stay forever. There is no scheduler, so the
 * sweep runs once at server start (`force`) and then opportunistically after a
 * commit, at most once a day — the same shape as the suspension TTL sweep.
 * It runs the same per-session delete as a commit: that delete follows the
 * `(session_id, created_at, seq)` index on every backend, and the work stays
 * in small steps with the event loop free in between.
 */

import { currentTraceRetention } from "@covel/shared";
import type { DataStore } from "@covel/store";

type TraceSweepStore = Pick<
  DataStore,
  "listSessions" | "deleteTraceEventsBefore" | "queryTraceEvents"
>;

/**
 * Delete a session's trace events older than `before`, except those of its
 * newest turn. The state of that turn is read from its `turn.started`,
 * `turn.completed` and `turn.failed` rows (the execution status, and the
 * retry of a failed or interrupted turn), so they outlive the retention
 * period: a player who comes back to the session later is still offered the
 * retry. One turn of traces per session is the cost.
 */
export async function deleteExpiredTraceEvents(
  store: Pick<DataStore, "deleteTraceEventsBefore" | "queryTraceEvents">,
  sessionId: string,
  before: string,
): Promise<void> {
  const [started] = await store.queryTraceEvents(sessionId, {
    types: ["turn.started"],
    newestFirst: true,
    limit: 1,
  });
  await store.deleteTraceEventsBefore(
    sessionId,
    started && started.createdAt < before ? started.createdAt : before,
  );
}

const SWEEP_INTERVAL_MS = 24 * 60 * 60_000;

let lastSweepAt = 0;
let sweeping = false;

export interface TraceSweepOptions {
  /** Bypass the daily gate (the startup sweep). */
  readonly force?: boolean;
  /** Injectable clock for tests. */
  readonly now?: number;
}

/**
 * Delete trace events older than the retention in force from every session.
 * Best-effort: a failure logs a warning and never throws. Returns the number
 * of sessions swept (0 when skipped, disabled, or failed).
 */
export async function maybeSweepOldTraces(
  store: TraceSweepStore,
  opts: TraceSweepOptions = {},
): Promise<number> {
  const now = opts.now ?? Date.now();
  if (sweeping) return 0;
  if (!opts.force && now - lastSweepAt < SWEEP_INTERVAL_MS) return 0;
  const { days } = currentTraceRetention();
  if (days <= 0) return 0;
  sweeping = true;
  lastSweepAt = now;
  let swept = 0;
  try {
    const before = new Date(now - days * 86_400_000).toISOString();
    for (const session of await store.listSessions()) {
      try {
        await deleteExpiredTraceEvents(store, session.id, before);
        swept += 1;
      } catch (error) {
        console.warn(
          `[trace-retention] sweep failed for ${session.id}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  } catch (error) {
    console.warn(
      "[trace-retention] sweep failed:",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    sweeping = false;
  }
  return swept;
}

/** Test-only: reset the module-level gate. */
export function __resetTraceSweepForTests(): void {
  lastSweepAt = 0;
  sweeping = false;
}
