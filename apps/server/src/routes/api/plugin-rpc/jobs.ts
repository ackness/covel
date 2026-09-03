import type { DataStore } from "@covel/store";
import type { PluginDataRecord, StoreTransaction } from "@covel/store";

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
 * Identity of the process that owns legacy in-process background jobs.
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

/** Durable scheduler source of truth; distinct from legacy plugin RPC `_jobs`. */
export const RUNTIME_JOB_NAMESPACE = "_runtime_jobs";
export const RUNTIME_JOB_SCHEMA_VERSION = 1 as const;
export const DEFAULT_RUNTIME_JOB_QUEUE_LIMIT = 256;

export type RuntimeJobStatus =
  | "queued"
  | "claimed"
  | "running"
  | "committing"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "stale"
  | "orphaned";

export type RuntimeJobActiveStatus = Extract<
  RuntimeJobStatus,
  "queued" | "claimed" | "running" | "committing"
>;

export interface RuntimeJobOrigin {
  readonly activation: "stage" | "event" | "manual";
  readonly sourceTurnId: string;
  readonly sourceExecutionId?: string;
  readonly sourceRuntimeId?: string;
}

export interface RuntimeJobValue {
  readonly schemaVersion: typeof RUNTIME_JOB_SCHEMA_VERSION;
  readonly jobId: string;
  readonly pluginId: string;
  readonly runtimeId: string;
  readonly status: RuntimeJobStatus;
  readonly origin: RuntimeJobOrigin;
  readonly payload: unknown;
  readonly enqueuedAt: string;
  readonly updatedAt: string;
  readonly attempt: number;
  readonly maxQueueMs?: number;
  readonly maxExecutionMs?: number;
  readonly deadlineAt?: string;
  readonly ownerId?: string;
  readonly leaseExpiresAt?: string;
  readonly claimedAt?: string;
  readonly startedAt?: string;
  readonly committingAt?: string;
  readonly finishedAt?: string;
  readonly backgroundTurnId?: string;
  readonly backgroundExecutionId?: string;
  readonly result?: unknown;
  readonly error?: string;
  readonly reason?: string;
}

export interface RuntimeJobRecord extends RuntimeJobValue {
  readonly sessionId: string;
}

type RuntimeJobStore = Pick<
  DataStore | StoreTransaction,
  | "compareAndSetPluginData"
  | "getPluginData"
  | "listPluginData"
  | "listPluginDataSessionScope"
  | "listSessions"
>;

export interface CreateRuntimeJobArgs {
  readonly jobId: string;
  readonly sessionId: string;
  readonly pluginId: string;
  readonly runtimeId: string;
  readonly origin: RuntimeJobOrigin;
  readonly payload: unknown;
  readonly enqueuedAt?: string;
  readonly maxQueueMs?: number;
  readonly maxExecutionMs?: number;
  readonly deadlineAt?: string;
  readonly maxQueuedPerSession?: number;
}

export interface TransitionRuntimeJobArgs {
  readonly sessionId: string;
  readonly pluginId: string;
  readonly jobId: string;
  readonly from: readonly RuntimeJobStatus[];
  readonly to: RuntimeJobStatus;
  readonly ownerId?: string;
  readonly now?: string;
  readonly leaseExpiresAt?: string;
  readonly backgroundTurnId?: string;
  readonly backgroundExecutionId?: string;
  readonly result?: unknown;
  readonly error?: string;
  readonly reason?: string;
}

export class RuntimeJobQueueFullError extends Error {
  readonly code = "RUNTIME_JOB_QUEUE_FULL";

  constructor(
    readonly sessionId: string,
    readonly limit: number,
  ) {
    super(`runtime job queue for session ${sessionId} reached limit ${limit}`);
    this.name = "RuntimeJobQueueFullError";
  }
}

const TERMINAL_RUNTIME_JOB_STATUSES: ReadonlySet<RuntimeJobStatus> = new Set([
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "stale",
  "orphaned",
]);

const LEGAL_RUNTIME_JOB_TRANSITIONS: Readonly<
  Record<RuntimeJobStatus, ReadonlySet<RuntimeJobStatus>>
> = {
  queued: new Set(["claimed", "failed", "timed_out", "cancelled"]),
  claimed: new Set(["running", "failed", "timed_out", "cancelled", "orphaned"]),
  running: new Set([
    "committing",
    "succeeded",
    "failed",
    "timed_out",
    "cancelled",
    "stale",
    "orphaned",
  ]),
  committing: new Set([
    "succeeded",
    "failed",
    "timed_out",
    "cancelled",
    "stale",
    "orphaned",
  ]),
  succeeded: new Set(),
  failed: new Set(),
  timed_out: new Set(),
  cancelled: new Set(),
  stale: new Set(),
  orphaned: new Set(),
};

function runtimeJobRowId(
  sessionId: string,
  pluginId: string,
  jobId: string,
): string {
  return `${sessionId}:${pluginId}:${RUNTIME_JOB_NAMESPACE}:${jobId}`;
}

function nextRevision(previous: string, now: string): string {
  const previousMs = Date.parse(previous);
  const nowMs = Date.parse(now);
  if (
    Number.isFinite(previousMs) &&
    Number.isFinite(nowMs) &&
    nowMs <= previousMs
  ) {
    return new Date(previousMs + 1).toISOString();
  }
  return now;
}

function isRuntimeJobStatus(value: unknown): value is RuntimeJobStatus {
  return (
    value === "queued" ||
    value === "claimed" ||
    value === "running" ||
    value === "committing" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "timed_out" ||
    value === "cancelled" ||
    value === "stale" ||
    value === "orphaned"
  );
}

function fromRuntimeJobRow(row: PluginDataRecord): RuntimeJobRecord | null {
  if (
    row.namespace !== RUNTIME_JOB_NAMESPACE ||
    !row.value ||
    typeof row.value !== "object"
  ) {
    return null;
  }
  const value = row.value as Partial<RuntimeJobValue>;
  if (
    value.schemaVersion !== RUNTIME_JOB_SCHEMA_VERSION ||
    value.jobId !== row.key ||
    value.pluginId !== row.pluginId ||
    typeof value.runtimeId !== "string" ||
    !isRuntimeJobStatus(value.status) ||
    typeof value.enqueuedAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    typeof value.attempt !== "number" ||
    !value.origin ||
    typeof value.origin.sourceTurnId !== "string"
  ) {
    return null;
  }
  return { ...(value as RuntimeJobValue), sessionId: row.sessionId };
}

function toRuntimeJobRow(record: RuntimeJobRecord): PluginDataRecord {
  const { sessionId, ...value } = record;
  return {
    id: runtimeJobRowId(sessionId, record.pluginId, record.jobId),
    sessionId,
    pluginId: record.pluginId,
    namespace: RUNTIME_JOB_NAMESPACE,
    key: record.jobId,
    value,
    createdAt: record.enqueuedAt,
    updatedAt: record.updatedAt,
  };
}

export async function createRuntimeJob(
  store: RuntimeJobStore,
  args: CreateRuntimeJobArgs,
): Promise<RuntimeJobRecord> {
  const maxQueued = args.maxQueuedPerSession ?? DEFAULT_RUNTIME_JOB_QUEUE_LIMIT;
  if (!Number.isSafeInteger(maxQueued) || maxQueued < 1) {
    throw new RangeError("maxQueuedPerSession must be a positive safe integer");
  }
  if (args.maxQueueMs !== undefined && args.maxQueueMs < 0) {
    throw new RangeError("maxQueueMs must be non-negative");
  }
  if (args.maxExecutionMs !== undefined && args.maxExecutionMs <= 0) {
    throw new RangeError("maxExecutionMs must be positive");
  }
  const duplicate = await getRuntimeJob(store, args);
  if (duplicate) return duplicate;
  const current = await listRuntimeJobs(store, {
    sessionId: args.sessionId,
    statuses: ["queued"],
  });
  if (current.length >= maxQueued) {
    throw new RuntimeJobQueueFullError(args.sessionId, maxQueued);
  }

  const enqueuedAt = args.enqueuedAt ?? new Date().toISOString();
  const record: RuntimeJobRecord = {
    schemaVersion: RUNTIME_JOB_SCHEMA_VERSION,
    jobId: args.jobId,
    sessionId: args.sessionId,
    pluginId: args.pluginId,
    runtimeId: args.runtimeId,
    status: "queued",
    origin: args.origin,
    payload: args.payload,
    enqueuedAt,
    updatedAt: enqueuedAt,
    attempt: 0,
    ...(args.maxQueueMs !== undefined ? { maxQueueMs: args.maxQueueMs } : {}),
    ...(args.maxExecutionMs !== undefined
      ? { maxExecutionMs: args.maxExecutionMs }
      : {}),
    ...(args.deadlineAt ? { deadlineAt: args.deadlineAt } : {}),
  };
  const inserted = await store.compareAndSetPluginData(
    toRuntimeJobRow(record),
    null,
  );
  if (!inserted) {
    const existing = await getRuntimeJob(store, args);
    if (existing) return existing;
    throw new Error(`runtime job ${args.jobId} already exists`);
  }
  return record;
}

export async function getRuntimeJob(
  store: Pick<DataStore | StoreTransaction, "getPluginData">,
  key: {
    readonly sessionId: string;
    readonly pluginId: string;
    readonly jobId: string;
  },
): Promise<RuntimeJobRecord | null> {
  const row = await store.getPluginData(
    key.sessionId,
    key.pluginId,
    RUNTIME_JOB_NAMESPACE,
    key.jobId,
  );
  return row ? fromRuntimeJobRow(row) : null;
}

export async function listRuntimeJobs(
  store: Pick<
    DataStore | StoreTransaction,
    "listPluginData" | "listPluginDataSessionScope"
  >,
  args: {
    readonly sessionId: string;
    readonly pluginId?: string;
    readonly statuses?: readonly RuntimeJobStatus[];
    readonly limit?: number;
  },
): Promise<readonly RuntimeJobRecord[]> {
  const rows = args.pluginId
    ? await store.listPluginData(
        args.sessionId,
        args.pluginId,
        RUNTIME_JOB_NAMESPACE,
      )
    : await store.listPluginDataSessionScope(args.sessionId);
  const statuses = args.statuses ? new Set(args.statuses) : undefined;
  const jobs = rows
    .map(fromRuntimeJobRow)
    .filter((job): job is RuntimeJobRecord => Boolean(job))
    .filter((job) => !statuses || statuses.has(job.status))
    .sort(
      (a, b) =>
        a.enqueuedAt.localeCompare(b.enqueuedAt) ||
        a.jobId.localeCompare(b.jobId),
    );
  return args.limit === undefined ? jobs : jobs.slice(0, args.limit);
}

export async function transitionRuntimeJob(
  store: RuntimeJobStore,
  args: TransitionRuntimeJobArgs,
): Promise<RuntimeJobRecord | null> {
  const existing = await getRuntimeJob(store, args);
  if (!existing || !args.from.includes(existing.status)) return null;
  if (!LEGAL_RUNTIME_JOB_TRANSITIONS[existing.status].has(args.to)) {
    throw new Error(
      `illegal runtime job transition: ${existing.status} -> ${args.to}`,
    );
  }
  if (args.ownerId !== undefined && existing.ownerId !== args.ownerId)
    return null;

  const suppliedNow = args.now ?? new Date().toISOString();
  const updatedAt = nextRevision(existing.updatedAt, suppliedNow);
  const terminal = TERMINAL_RUNTIME_JOB_STATUSES.has(args.to);
  const next: RuntimeJobRecord = {
    ...existing,
    status: args.to,
    updatedAt,
    ...(args.to === "running" && !existing.startedAt
      ? { startedAt: updatedAt }
      : {}),
    ...(args.to === "committing" ? { committingAt: updatedAt } : {}),
    ...(terminal ? { finishedAt: updatedAt } : {}),
    ...(args.leaseExpiresAt ? { leaseExpiresAt: args.leaseExpiresAt } : {}),
    ...(args.backgroundTurnId
      ? { backgroundTurnId: args.backgroundTurnId }
      : {}),
    ...(args.backgroundExecutionId
      ? { backgroundExecutionId: args.backgroundExecutionId }
      : {}),
    ...(args.result !== undefined ? { result: args.result } : {}),
    ...(args.error !== undefined ? { error: args.error } : {}),
    ...(args.reason !== undefined ? { reason: args.reason } : {}),
  };
  const swapped = await store.compareAndSetPluginData(
    toRuntimeJobRow(next),
    existing.updatedAt,
  );
  return swapped ? next : null;
}

export async function claimRuntimeJob(
  store: RuntimeJobStore,
  args: {
    readonly sessionId: string;
    readonly pluginId: string;
    readonly jobId: string;
    readonly ownerId: string;
    readonly leaseMs: number;
    readonly now?: string;
  },
): Promise<RuntimeJobRecord | null> {
  if (!Number.isSafeInteger(args.leaseMs) || args.leaseMs <= 0) {
    throw new RangeError("leaseMs must be a positive safe integer");
  }
  const existing = await getRuntimeJob(store, args);
  if (!existing || existing.status !== "queued") return null;
  const now = args.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  const queueDeadline =
    existing.maxQueueMs === undefined
      ? undefined
      : Date.parse(existing.enqueuedAt) + existing.maxQueueMs;
  if (
    (queueDeadline !== undefined && nowMs >= queueDeadline) ||
    (existing.deadlineAt !== undefined &&
      nowMs >= Date.parse(existing.deadlineAt))
  ) {
    await transitionRuntimeJob(store, {
      sessionId: args.sessionId,
      pluginId: args.pluginId,
      jobId: args.jobId,
      from: ["queued"],
      to: "timed_out",
      now,
      reason: "queue-deadline-exceeded",
    });
    return null;
  }

  const updatedAt = nextRevision(existing.updatedAt, now);
  const claimed: RuntimeJobRecord = {
    ...existing,
    status: "claimed",
    ownerId: args.ownerId,
    claimedAt: updatedAt,
    updatedAt,
    attempt: existing.attempt + 1,
    leaseExpiresAt: new Date(nowMs + args.leaseMs).toISOString(),
  };
  const swapped = await store.compareAndSetPluginData(
    toRuntimeJobRow(claimed),
    existing.updatedAt,
  );
  return swapped ? claimed : null;
}

export async function renewRuntimeJobLease(
  store: RuntimeJobStore,
  args: {
    readonly sessionId: string;
    readonly pluginId: string;
    readonly jobId: string;
    readonly ownerId: string;
    readonly leaseMs: number;
    readonly now?: string;
  },
): Promise<RuntimeJobRecord | null> {
  if (!Number.isSafeInteger(args.leaseMs) || args.leaseMs <= 0) {
    throw new RangeError("leaseMs must be a positive safe integer");
  }
  const existing = await getRuntimeJob(store, args);
  if (
    !existing ||
    existing.ownerId !== args.ownerId ||
    !(["claimed", "running", "committing"] as RuntimeJobStatus[]).includes(
      existing.status,
    )
  ) {
    return null;
  }
  const now = args.now ?? new Date().toISOString();
  const updatedAt = nextRevision(existing.updatedAt, now);
  const renewed: RuntimeJobRecord = {
    ...existing,
    updatedAt,
    leaseExpiresAt: new Date(Date.parse(now) + args.leaseMs).toISOString(),
  };
  const swapped = await store.compareAndSetPluginData(
    toRuntimeJobRow(renewed),
    existing.updatedAt,
  );
  return swapped ? renewed : null;
}

export interface ClaimedRuntimeJob {
  readonly job: RuntimeJobRecord;
  /** Feed into the next call to preserve round-robin session fairness. */
  readonly nextSessionCursor: string;
}

export async function claimNextRuntimeJob(
  store: RuntimeJobStore,
  args: {
    readonly ownerId: string;
    readonly leaseMs: number;
    readonly afterSessionId?: string;
    readonly sessionId?: string;
    readonly excludeRuntimeKeys?: ReadonlySet<string>;
  },
): Promise<ClaimedRuntimeJob | null> {
  const sessionIds = args.sessionId
    ? [args.sessionId]
    : (await store.listSessions()).map((session) => session.id).sort();
  if (sessionIds.length === 0) return null;
  const cursorIndex = args.afterSessionId
    ? sessionIds.indexOf(args.afterSessionId)
    : -1;
  const rotated = [
    ...sessionIds.slice(cursorIndex + 1),
    ...sessionIds.slice(0, cursorIndex + 1),
  ];
  for (const sessionId of rotated) {
    const candidates = await listRuntimeJobs(store, {
      sessionId,
      statuses: ["queued"],
    });
    const candidate = candidates.find(
      (job) =>
        !args.excludeRuntimeKeys?.has(
          `${job.sessionId}\u0000${job.pluginId}\u0000${job.runtimeId}`,
        ),
    );
    if (!candidate) continue;
    const claimed = await claimRuntimeJob(store, {
      sessionId,
      pluginId: candidate.pluginId,
      jobId: candidate.jobId,
      ownerId: args.ownerId,
      leaseMs: args.leaseMs,
    });
    if (claimed) return { job: claimed, nextSessionCursor: sessionId };
  }
  return null;
}

/** Terminalise expired work; never automatically replay potentially paid work. */
export async function recoverExpiredRuntimeJobs(
  store: RuntimeJobStore,
  opts: { readonly now?: string } = {},
): Promise<{ readonly timedOut: number; readonly orphaned: number }> {
  const now = opts.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  let timedOut = 0;
  let orphaned = 0;
  for (const session of await store.listSessions()) {
    const jobs = await listRuntimeJobs(store, { sessionId: session.id });
    for (const job of jobs) {
      if (job.status === "queued") {
        const queueDeadline =
          job.maxQueueMs === undefined
            ? undefined
            : Date.parse(job.enqueuedAt) + job.maxQueueMs;
        if (
          (queueDeadline !== undefined && nowMs >= queueDeadline) ||
          (job.deadlineAt !== undefined && nowMs >= Date.parse(job.deadlineAt))
        ) {
          const changed = await transitionRuntimeJob(store, {
            sessionId: job.sessionId,
            pluginId: job.pluginId,
            jobId: job.jobId,
            from: ["queued"],
            to: "timed_out",
            now,
            reason: "queue-deadline-exceeded",
          });
          if (changed) timedOut++;
        }
        continue;
      }
      if (
        (job.status === "claimed" ||
          job.status === "running" ||
          job.status === "committing") &&
        job.leaseExpiresAt !== undefined &&
        nowMs >= Date.parse(job.leaseExpiresAt)
      ) {
        const changed = await transitionRuntimeJob(store, {
          sessionId: job.sessionId,
          pluginId: job.pluginId,
          jobId: job.jobId,
          from: [job.status],
          to: "orphaned",
          now,
          reason: "lease-expired",
          error: "runtime job owner stopped renewing its lease",
        });
        if (changed) orphaned++;
      }
    }
  }
  return { timedOut, orphaned };
}

/**
 * One-shot boot sweep: mark `pending` background-job rows owned by a dead
 * process as `failed`, so clients watching a job that died with a previous
 * process get a terminal status instead of an eternal spinner. Best-effort —
 * callers fire-and-forget.
 *
 * Ownership, not age, is the test: a fresh single-process server cannot own a
 * row written by the previous process. This legacy `_jobs` sweep is therefore
 * disabled for multi-Pod PG; staged `_runtime_jobs` use renewable leases.
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
