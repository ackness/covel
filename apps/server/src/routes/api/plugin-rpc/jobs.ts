import type { DataStore } from "@covel/store";

export type PluginJobValue = Readonly<Record<string, unknown>> & {
  readonly status: "pending" | "done" | "failed";
  readonly progress: number;
};

export interface PluginJobTriggerEvent {
  readonly topic: string;
  readonly data: Readonly<Record<string, unknown>>;
}

interface PluginJobValueBaseArgs {
  readonly runtimeId: string;
  readonly turnId: string;
  readonly startedAt: string;
  readonly payload?: unknown;
  readonly triggerEvent?: PluginJobTriggerEvent;
  readonly phase?: string;
  readonly message?: string;
  readonly messageKey?: string;
}

interface PendingPluginJobValueArgs extends PluginJobValueBaseArgs {
  readonly progress?: number;
}

interface TerminalPluginJobValueArgs extends PluginJobValueBaseArgs {
  readonly status: "done" | "failed";
  readonly progress?: number;
  readonly completedAt: string;
  readonly durationMs?: number;
  readonly runtimeResults?: readonly unknown[];
  readonly deferredJobs?: readonly unknown[];
  readonly error?: string;
  readonly abortReason?: string;
  readonly reason?: string;
}

function addDefined(
  value: Record<string, unknown>,
  key: string,
  item: unknown,
): void {
  if (item !== undefined) value[key] = item;
}

export function makePendingPluginJobValue(
  args: PendingPluginJobValueArgs,
): PluginJobValue {
  const value: Record<string, unknown> = {
    status: "pending",
    progress: args.progress ?? 5,
    runtimeId: args.runtimeId,
    turnId: args.turnId,
  };
  addDefined(value, "payload", args.payload);
  addDefined(value, "triggerEvent", args.triggerEvent);
  value.startedAt = args.startedAt;
  addDefined(value, "phase", args.phase);
  addDefined(value, "message", args.message);
  addDefined(value, "messageKey", args.messageKey);
  return value as PluginJobValue;
}

export function makeTerminalPluginJobValue(
  args: TerminalPluginJobValueArgs,
): PluginJobValue {
  const value: Record<string, unknown> = {
    status: args.status,
    progress: args.progress ?? 100,
    runtimeId: args.runtimeId,
    turnId: args.turnId,
  };
  addDefined(value, "payload", args.payload);
  addDefined(value, "triggerEvent", args.triggerEvent);
  value.startedAt = args.startedAt;
  value.completedAt = args.completedAt;
  addDefined(value, "durationMs", args.durationMs);
  addDefined(value, "phase", args.phase);
  addDefined(value, "message", args.message);
  addDefined(value, "messageKey", args.messageKey);
  addDefined(value, "runtimeResults", args.runtimeResults);
  addDefined(value, "deferredJobs", args.deferredJobs);
  addDefined(value, "error", args.error);
  addDefined(value, "abortReason", args.abortReason);
  addDefined(value, "reason", args.reason);
  return value as PluginJobValue;
}

export interface WritePluginJobArgs {
  readonly sessionId: string;
  readonly pluginId: string;
  readonly jobId: string;
  readonly startedAt: string;
  readonly updatedAt?: string;
  readonly value: PluginJobValue;
}

export async function writePluginJob(
  store: DataStore,
  args: WritePluginJobArgs,
): Promise<void> {
  await store.setPluginData({
    id: `${args.sessionId}:${args.pluginId}:_jobs:${args.jobId}`,
    sessionId: args.sessionId,
    pluginId: args.pluginId,
    namespace: "_jobs",
    key: args.jobId,
    value: args.value,
    createdAt: args.startedAt,
    updatedAt: args.updatedAt ?? args.startedAt,
  });
}

// ── Startup crash-recovery sweep ─────────────────────────────────────

/**
 * Pending jobs older than this are presumed orphaned: background jobs run
 * in-process via setImmediate, so a crash/restart kills the callback while
 * the row stays `pending` forever. The threshold is generous enough that a
 * job legitimately still running on another pod is never reaped.
 */
const STALE_PENDING_JOB_MS = 15 * 60_000;

/**
 * How often the periodic re-sweep runs (audit 2026-07-16 M-2). Smaller than
 * the staleness threshold so a job orphaned just before a crash is reaped soon
 * after it crosses `STALE_PENDING_JOB_MS`, instead of only at the next boot.
 */
export const JOB_SWEEP_INTERVAL_MS = 5 * 60_000;

/**
 * One-shot boot sweep: mark stale `pending` background-job rows as `failed`
 * so clients polling a job that died with a previous process get a terminal
 * status instead of an eternal spinner. Best-effort — callers fire-and-forget.
 *
 * ponytail: full-session plugin_data scan at boot; move to an indexed
 * namespace query if plugin_data volume ever makes boot noticeably slower.
 * Re-driving (instead of failing) orphaned jobs would need a durable queue
 * with leases/idempotency — deliberately out of scope.
 */
export async function sweepStalePendingJobs(
  store: DataStore,
  opts: { readonly staleMs?: number; readonly now?: number } = {},
): Promise<number> {
  const staleMs = opts.staleMs ?? STALE_PENDING_JOB_MS;
  const now = opts.now ?? Date.now();
  let swept = 0;

  for (const session of await store.listSessions()) {
    let rows;
    try {
      rows = await store.listPluginDataSessionScope(session.id);
    } catch (err) {
      console.warn(
        `[job-sweep] could not list plugin data for session ${session.id}:`,
        err instanceof Error ? err.message : String(err),
      );
      continue;
    }
    for (const row of rows) {
      if (row.namespace !== "_jobs") continue;
      const value = row.value as Partial<PluginJobValue> & {
        readonly startedAt?: string;
        readonly runtimeId?: string;
        readonly turnId?: string;
      };
      if (value?.status !== "pending") continue;
      // Freshness is the most recent write to the row, not just its start:
      // a job that writes progress bumps `updatedAt`, and the sweep now runs
      // periodically (not only at boot), so anchoring on `startedAt` alone
      // would force-fail a legitimately long-running job. A job that never
      // writes progress still ages out at `staleMs` from its start (unchanged
      // boot-recovery behavior).
      const startedAtMs = Date.parse(value.startedAt ?? row.updatedAt);
      const updatedAtMs = Date.parse(row.updatedAt);
      const lastActivityMs = Math.max(
        Number.isFinite(startedAtMs) ? startedAtMs : -Infinity,
        Number.isFinite(updatedAtMs) ? updatedAtMs : -Infinity,
      );
      if (Number.isFinite(lastActivityMs) && now - lastActivityMs < staleMs) {
        continue;
      }

      const startedAt = value.startedAt ?? row.createdAt;
      const completedAt = new Date(now).toISOString();
      try {
        await writePluginJob(store, {
          sessionId: row.sessionId,
          pluginId: row.pluginId,
          jobId: row.key,
          startedAt,
          updatedAt: completedAt,
          value: makeTerminalPluginJobValue({
            status: "failed",
            runtimeId: value.runtimeId ?? "unknown",
            turnId: value.turnId ?? "unknown",
            startedAt,
            completedAt,
            error:
              "orphaned pending job (server restarted before the job completed)",
          }),
        });
        swept++;
      } catch (err) {
        console.warn(
          `[job-sweep] could not fail orphaned job ${row.key} (session ${row.sessionId}):`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  if (swept > 0) {
    console.warn(
      `[job-sweep] marked ${swept} orphaned pending background job(s) as failed`,
    );
  }
  return swept;
}
