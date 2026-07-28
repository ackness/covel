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

/**
 * Identity of the process that owns the background jobs written by this
 * instance. Background jobs run in-process (`setImmediate`), so a `pending`
 * row whose owner is not the live process has no executor and never will —
 * the only event that can orphan a job is the death of the process running
 * it, and that is always followed by a boot.
 *
 * This is what lets the boot sweep be exact instead of a timeout guess, and
 * why no heartbeat is needed: liveness is answered by identity, not by time.
 * Same pattern as the event bus's `originId`.
 */
const PROCESS_ID = crypto.randomUUID();

export function makePendingPluginJobValue(
  args: PendingPluginJobValueArgs,
): PluginJobValue {
  const value: Record<string, unknown> = {
    status: "pending",
    progress: args.progress ?? 5,
    runtimeId: args.runtimeId,
    turnId: args.turnId,
    owner: PROCESS_ID,
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
 * One-shot boot sweep: mark `pending` background-job rows owned by a dead
 * process as `failed`, so clients watching a job that died with a previous
 * process get a terminal status instead of an eternal spinner. Best-effort —
 * callers fire-and-forget.
 *
 * Ownership, not age, is the test. A pending row belongs to a live executor
 * only if its `owner` matches this process; the freshly booted process cannot
 * own any pre-existing row, so a legitimately running job is never reaped —
 * that holds by construction, not by picking a generous threshold. Rows
 * written before `owner` existed carry none, which correctly reads as "some
 * earlier process wrote this".
 *
 * **This assumes one server process per store.** It is exact for the single
 * instance deployments Covel ships today (desktop, self-host), where the only
 * way to orphan a job is for its process to die. It is NOT safe for multiple
 * instances sharing a database: a booting instance would read every other
 * instance's in-flight rows as foreign and fail them immediately. The
 * threshold this replaced left a 15-minute grace window for that case — still
 * not correct (it killed anything slower than the threshold), but not instant.
 * Before running more than one instance, `owner` must be paired with a lease
 * (`leaseExpiresAt` renewed while the job runs) so the test becomes "foreign
 * AND expired" rather than merely "foreign".
 *
 * Orphans are failed rather than re-driven: re-running costs real money
 * (image/TTS generation), and the request-scoped `userSettings` a re-run would
 * need is not persisted on the row — it would silently re-bill with different
 * parameters. The terminal row keeps `triggerEvent` / `payload` so a plugin UI
 * or the player can retry deliberately.
 *
 * ponytail: full-session plugin_data scan at boot; move to an indexed
 * namespace query if plugin_data volume ever makes boot noticeably slower.
 */
export async function sweepStalePendingJobs(
  store: DataStore,
  opts: { readonly now?: number } = {},
): Promise<number> {
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
        readonly owner?: string;
        readonly payload?: unknown;
        readonly triggerEvent?: PluginJobTriggerEvent;
      };
      if (value?.status !== "pending") continue;
      // Owned by this process — its executor is alive (or about to be).
      if (value.owner === PROCESS_ID) continue;

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
            // Carried over so a plugin UI (or the player) can re-trigger this
            // exact job; the sweep deliberately does not re-run it itself.
            ...(value.payload !== undefined ? { payload: value.payload } : {}),
            ...(value.triggerEvent ? { triggerEvent: value.triggerEvent } : {}),
            // Distinguishes "the process died" from "the job itself failed",
            // matching the existing `reason` vocabulary on terminal rows.
            reason: "orphaned",
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
