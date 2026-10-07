import type { DataStore } from "@covel/store";
import type { PluginDataRecord, StoreTransaction } from "@covel/store";
import type { SessionLock } from "../../../lib/session-lock.js";

/** Durable queue for detached stages and background manual/event activations. */
const RUNTIME_JOB_NAMESPACE = "_runtime_jobs";
const RUNTIME_JOB_SCHEMA_VERSION = 1 as const;
const DEFAULT_RUNTIME_JOB_QUEUE_LIMIT = 256;

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
  /** Monotonic enqueue order within the session/plugin queue. */
  readonly sequence: number;
  readonly settle?: "before-next-execution";
  readonly maxSettleWaitMs?: number;
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
  | "listPluginDataByNamespace"
  | "queryPluginData"
> &
  Partial<Pick<DataStore, "withTransaction">>;

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
  readonly settle?: "before-next-execution";
  readonly maxSettleWaitMs?: number;
  readonly retryOfJobId?: string;
}

export interface TransitionRuntimeJobArgs {
  readonly sessionId: string;
  readonly pluginId: string;
  readonly jobId: string;
  readonly from: readonly RuntimeJobStatus[];
  readonly to: RuntimeJobStatus;
  readonly ownerId?: string;
  readonly now?: string;
  readonly expectedUpdatedAt?: string;
  readonly leaseExpiresAt?: string;
  readonly backgroundTurnId?: string;
  readonly backgroundExecutionId?: string;
  readonly result?: unknown;
  readonly error?: string;
  readonly reason?: string;
}

export class RuntimeJobSupersededError extends Error {
  constructor() {
    super("settling job retry would overwrite a later source execution");
    this.name = "RuntimeJobSupersededError";
  }
}

class RuntimeJobQueueChangedError extends Error {
  constructor() {
    super("runtime job queue changed during enqueue; retry the transaction");
    this.name = "RuntimeJobQueueChangedError";
  }
}

export class RuntimeJobQueueFullError extends Error {
  constructor(
    readonly sessionId: string,
    readonly limit: number,
  ) {
    super(`runtime job queue for session ${sessionId} reached limit ${limit}`);
    this.name = "RuntimeJobQueueFullError";
  }
}

export const TERMINAL_RUNTIME_JOB_STATUSES: ReadonlySet<RuntimeJobStatus> =
  new Set([
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
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence ?? 0) < 1 ||
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
  if (store.withTransaction) {
    return store.withTransaction((tx) => createRuntimeJob(tx, args));
  }
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
  if (
    args.maxSettleWaitMs !== undefined &&
    (!args.settle ||
      !Number.isSafeInteger(args.maxSettleWaitMs) ||
      args.maxSettleWaitMs <= 0)
  ) {
    throw new RangeError(
      "maxSettleWaitMs requires settle and must be positive",
    );
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

  const prior = await listRuntimeJobs(store, {
    sessionId: args.sessionId,
    pluginId: args.pluginId,
  });
  if (args.settle && args.retryOfJobId) {
    const source = prior.find((job) => job.jobId === args.retryOfJobId);
    if (
      !source ||
      prior.some(
        (job) =>
          job.runtimeId === args.runtimeId && job.sequence > source.sequence,
      )
    )
      throw new RuntimeJobSupersededError();
  }
  const enqueuedAt = args.enqueuedAt ?? new Date().toISOString();
  // The counter CAS serializes concurrent PostgreSQL enqueue transactions.
  // Source-turn callers already hold the session lock; a conflicting direct
  // caller fails its transaction instead of publishing an ambiguous order.
  const counterNamespace = "_runtime_job_control";
  const counter = await store.getPluginData(
    args.sessionId,
    args.pluginId,
    counterNamespace,
    "sequence",
  );
  const counterValue = counter?.value as { sequence?: unknown } | undefined;
  const previousSequence =
    typeof counterValue?.sequence === "number" ? counterValue.sequence : 0;
  const sequence =
    prior.reduce(
      (latest, job) => Math.max(latest, job.sequence),
      previousSequence,
    ) + 1;
  if (!Number.isSafeInteger(sequence))
    throw new RangeError("runtime job sequence exhausted");
  const counterUpdatedAt = counter
    ? nextRevision(counter.updatedAt, enqueuedAt)
    : enqueuedAt;
  if (
    !(await store.compareAndSetPluginData(
      {
        id: `${args.sessionId}:${args.pluginId}:${counterNamespace}:sequence`,
        sessionId: args.sessionId,
        pluginId: args.pluginId,
        namespace: counterNamespace,
        key: "sequence",
        value: { sequence },
        createdAt: counter?.createdAt ?? enqueuedAt,
        updatedAt: counterUpdatedAt,
      },
      counter?.updatedAt ?? null,
    ))
  )
    throw new RuntimeJobQueueChangedError();
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
    sequence,
    ...(args.settle ? { settle: args.settle } : {}),
    ...(args.maxSettleWaitMs !== undefined
      ? { maxSettleWaitMs: args.maxSettleWaitMs }
      : {}),
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

/** One namespace scan shared by maintenance, reconciliation and claiming. */
export async function listAllRuntimeJobs(
  store: Pick<DataStore, "queryPluginData">,
): Promise<RuntimeJobRecord[]> {
  return (await store.queryPluginData({ namespace: RUNTIME_JOB_NAMESPACE }))
    .map(fromRuntimeJobRow)
    .filter((job): job is RuntimeJobRecord => job !== null)
    .sort(
      (a, b) =>
        a.sequence - b.sequence ||
        a.enqueuedAt.localeCompare(b.enqueuedAt) ||
        a.jobId.localeCompare(b.jobId),
    );
}

export async function listRuntimeJobs(
  store: Pick<
    DataStore | StoreTransaction,
    "listPluginData" | "listPluginDataByNamespace"
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
    : await store.listPluginDataByNamespace(
        args.sessionId,
        RUNTIME_JOB_NAMESPACE,
      );
  const statuses = args.statuses ? new Set(args.statuses) : undefined;
  const jobs = rows
    .map(fromRuntimeJobRow)
    .filter((job): job is RuntimeJobRecord => Boolean(job))
    .filter((job) => !statuses || statuses.has(job.status))
    .sort(
      (a, b) =>
        a.sequence - b.sequence ||
        a.enqueuedAt.localeCompare(b.enqueuedAt) ||
        a.jobId.localeCompare(b.jobId),
    );
  return args.limit === undefined ? jobs : jobs.slice(0, args.limit);
}

export async function listSettlingRuntimeJobs(
  store: Parameters<typeof listRuntimeJobs>[0] &
    Pick<import("@covel/store").DataStore, "getSession">,
  sessionId: string,
): Promise<readonly RuntimeJobRecord[]> {
  const session = await store.getSession(sessionId);
  if (!session) return [];
  return (await listRuntimeJobs(store, { sessionId })).filter(
    (job) =>
      session.activePlugins.includes(job.pluginId) &&
      job.settle === "before-next-execution" &&
      !TERMINAL_RUNTIME_JOB_STATUSES.has(job.status),
  );
}

export async function transitionRuntimeJob(
  store: RuntimeJobStore,
  args: TransitionRuntimeJobArgs,
): Promise<RuntimeJobRecord | null> {
  const existing = await getRuntimeJob(store, args);
  if (!existing || !args.from.includes(existing.status)) return null;
  if (
    args.expectedUpdatedAt !== undefined &&
    existing.updatedAt !== args.expectedUpdatedAt
  ) {
    return null;
  }
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
  if (store.withTransaction) {
    return store.withTransaction((tx) => claimRuntimeJob(tx, args));
  }
  if (!Number.isSafeInteger(args.leaseMs) || args.leaseMs <= 0) {
    throw new RangeError("leaseMs must be a positive safe integer");
  }
  const existing = await getRuntimeJob(store, args);
  if (!existing || existing.status !== "queued") return null;
  const predecessors = await listRuntimeJobs(store, {
    sessionId: args.sessionId,
    pluginId: args.pluginId,
  });
  if (
    predecessors.some(
      (job) =>
        job.runtimeId === existing.runtimeId &&
        job.sequence < existing.sequence &&
        !TERMINAL_RUNTIME_JOB_STATUSES.has(job.status),
    )
  )
    return null;
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
    readonly jobs?: readonly RuntimeJobRecord[];
    /** Only these sessions; every session when omitted. */
    readonly sessionIds?: readonly string[];
    readonly excludeRuntimeKeys?: ReadonlySet<string>;
    /** Missing request services keep a job queued, without consuming an attempt. */
    readonly canClaim?: (job: RuntimeJobRecord) => boolean | Promise<boolean>;
  },
): Promise<ClaimedRuntimeJob | null> {
  const jobs =
    args.jobs ??
    (args.sessionIds ? undefined : await listAllRuntimeJobs(store));
  const sessionIds = [
    ...new Set(
      args.sessionIds ??
        jobs!
          .filter((job) => job.status === "queued")
          .map((job) => job.sessionId),
    ),
  ].sort();
  if (sessionIds.length === 0) return null;
  const cursorIndex = args.afterSessionId
    ? sessionIds.indexOf(args.afterSessionId)
    : -1;
  const rotated = [
    ...sessionIds.slice(cursorIndex + 1),
    ...sessionIds.slice(0, cursorIndex + 1),
  ];
  for (const sessionId of rotated) {
    const candidates = jobs
      ? jobs.filter(
          (job) => job.sessionId === sessionId && job.status === "queued",
        )
      : await listRuntimeJobs(store, {
          sessionId,
          statuses: ["queued"],
        });
    for (const candidate of candidates) {
      if (
        args.excludeRuntimeKeys?.has(
          `${candidate.sessionId}\u0000${candidate.pluginId}\u0000${candidate.runtimeId}`,
        )
      ) {
        continue;
      }
      if (args.canClaim && !(await args.canClaim(candidate))) continue;
      const claimed = await claimRuntimeJob(store, {
        sessionId,
        pluginId: candidate.pluginId,
        jobId: candidate.jobId,
        ownerId: args.ownerId,
        leaseMs: args.leaseMs,
      });
      if (claimed) return { job: claimed, nextSessionCursor: sessionId };
    }
  }
  return null;
}

/** Terminal jobs kept per session runtime; older rows are deleted. */
const RETAINED_TERMINAL_RUNTIME_JOBS = 20;

/**
 * Bound job history. Terminal rows only serve status queries and deliberate
 * retry of recent failures; keeping one row per turn forever made every
 * session-wide job read grow with session length. Returns the rows that remain.
 */
export async function pruneTerminalRuntimeJobs(
  store: Pick<DataStore, "deletePluginData" | "deleteJobStatus">,
  sessionId: string,
  jobs: readonly RuntimeJobRecord[],
  keep = RETAINED_TERMINAL_RUNTIME_JOBS,
): Promise<readonly RuntimeJobRecord[]> {
  const terminalByRuntime = new Map<string, RuntimeJobRecord[]>();
  for (const job of jobs) {
    if (!TERMINAL_RUNTIME_JOB_STATUSES.has(job.status)) continue;
    const key = `${job.pluginId}\u0000${job.runtimeId}`;
    const group = terminalByRuntime.get(key) ?? [];
    group.push(job);
    terminalByRuntime.set(key, group);
  }
  const pruned = new Set<string>();
  for (const group of terminalByRuntime.values()) {
    // `jobs` comes from listRuntimeJobs, so each group is sequence-ordered.
    for (const job of group.slice(0, Math.max(0, group.length - keep))) {
      await store.deletePluginData(
        sessionId,
        job.pluginId,
        RUNTIME_JOB_NAMESPACE,
        job.jobId,
      );
      pruned.add(job.jobId);
    }
  }
  if (pruned.size > 0) await store.deleteJobStatus(sessionId, [...pruned]);
  return pruned.size === 0
    ? jobs
    : jobs.filter((job) => !pruned.has(job.jobId));
}

/** Terminalise expired work; never automatically replay potentially paid work. */
export async function recoverExpiredRuntimeJobs(
  store: RuntimeJobStore,
  opts: {
    readonly now?: string;
    readonly jobs?: readonly RuntimeJobRecord[];
    readonly onChanged?: (job: RuntimeJobRecord) => void;
    readonly tryWithCommitLock: NonNullable<SessionLock["tryWithLock"]>;
  },
): Promise<{ readonly timedOut: number; readonly orphaned: number }> {
  const now = opts.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  let timedOut = 0;
  let orphaned = 0;
  const jobs = opts.jobs ?? (await listAllRuntimeJobs(store));
  {
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
          if (changed) {
            timedOut++;
            opts.onChanged?.(changed);
          }
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
        const recover = () =>
          transitionRuntimeJob(store, {
            sessionId: job.sessionId,
            pluginId: job.pluginId,
            jobId: job.jobId,
            from: [job.status],
            to: "orphaned",
            now,
            expectedUpdatedAt: job.updatedAt,
            reason: "lease-expired",
            error: "runtime job owner stopped renewing its lease",
          });
        // Committing jobs stop renewing while the runner owns the session
        // commit lock. An expired timestamp alone cannot identify a dead owner.
        if (job.status === "committing") {
          const recovered = await opts.tryWithCommitLock(
            job.sessionId,
            recover,
          );
          if (recovered.acquired && recovered.value) {
            orphaned++;
            opts.onChanged?.(recovered.value);
          }
        } else {
          const recovered = await recover();
          if (recovered) {
            orphaned++;
            opts.onChanged?.(recovered);
          }
        }
      }
    }
  }
  return { timedOut, orphaned };
}
