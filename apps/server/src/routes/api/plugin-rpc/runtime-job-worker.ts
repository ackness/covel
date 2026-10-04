import { turnDigestSchema } from "@covel/shared";
import type { EventBus } from "@covel/events";
import type { DataStore, StoreTransaction } from "@covel/store";
import { SessionNotFoundError } from "@covel/store/session";
import type {
  DeferredRuntimeJob,
  JobStatusRecord,
  JobStatusState,
  JsonValue,
} from "@covel/shared";
import type { SessionLock } from "../../../lib/session-lock.js";

import {
  claimNextRuntimeJob,
  getRuntimeJob,
  listRuntimeJobs,
  pruneTerminalRuntimeJobs,
  recoverExpiredRuntimeJobs,
  renewRuntimeJobLease,
  transitionRuntimeJob,
  type RuntimeJobRecord,
  type RuntimeJobStatus,
} from "./jobs.js";
import { publicRuntimeJobDiagnostics } from "./runtime-job-public.js";
import {
  SESSION_DELETION_PENDING_KEY,
  SESSION_INCARNATION_KEY,
} from "../session/session-guard.js";

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_LEASE_MS = 120_000;
const DRAIN_RETRY_MS = 1_000;
const MAINTENANCE_INTERVAL_MS = 30_000;
/** Clock-skew margin when revisiting jobs finished since the last full pass. */
const RECONCILE_OVERLAP_MS = 5_000;

export interface StagedRuntimeJobPayload {
  readonly schemaVersion: 1;
  readonly descriptor: DeferredRuntimeJob;
  readonly expectedSessionIncarnation: string;
  readonly expectedApprovalScope: string;
  readonly locale: string;
  readonly modelOverride?: string;
  readonly runtimeModelOverrides?: Readonly<Record<string, string>>;
  readonly userSettings?: Readonly<
    Record<string, Readonly<Record<string, unknown>>>
  >;
}

export function parseStagedRuntimeJobPayload(
  value: unknown,
): StagedRuntimeJobPayload | undefined {
  if (!value || typeof value !== "object") return undefined;
  const payload = value as Partial<StagedRuntimeJobPayload>;
  const descriptor = payload.descriptor as
    Partial<DeferredRuntimeJob> | undefined;
  if (
    payload.schemaVersion !== 1 ||
    typeof payload.expectedSessionIncarnation !== "string" ||
    typeof payload.expectedApprovalScope !== "string" ||
    typeof payload.locale !== "string" ||
    !descriptor ||
    typeof descriptor.jobId !== "string" ||
    typeof descriptor.runtimeId !== "string" ||
    typeof descriptor.pluginId !== "string" ||
    typeof descriptor.sourceTurnId !== "string" ||
    typeof descriptor.sourceExecutionId !== "string" ||
    typeof descriptor.sourceExecutionStartedAt !== "string" ||
    !Array.isArray(descriptor.upstreamResults)
  ) {
    return undefined;
  }
  const digest = turnDigestSchema.safeParse(descriptor.turnDigest);
  if (!digest.success || digest.data.turnId !== descriptor.sourceTurnId)
    return undefined;
  return {
    ...payload,
    descriptor: { ...descriptor, turnDigest: digest.data },
  } as StagedRuntimeJobPayload;
}

export interface RuntimeJobTriggerEvent {
  readonly topic: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/**
 * Durable input for a runtime activated outside the stage scheduler: a
 * plugin-rpc `execution: background` call (`manual`) or a background follower
 * of an emitted event (`event`). `turnId` is fixed at enqueue so the caller can
 * correlate the execution before it runs.
 */
export interface ActivatedRuntimeJobPayload {
  readonly schemaVersion: 1;
  readonly activation: "manual" | "event";
  readonly turnId: string;
  readonly expectedSessionIncarnation: string;
  readonly expectedApprovalScope: string;
  readonly locale: string;
  readonly runtimeModelOverrides?: Readonly<Record<string, string>>;
  readonly userSettings?: Readonly<
    Record<string, Readonly<Record<string, unknown>>>
  >;
  /** Manual activation input (`ctx.activation` payload). */
  readonly input?: unknown;
  /** Manual retry of a recorded turn; its results seed the run at execution. */
  readonly retryFromTurnId?: string;
  /** Event activation trigger. */
  readonly triggerEvent?: RuntimeJobTriggerEvent;
  /** The runtime only prepares input for a background follower it must emit. */
  readonly expectFollower?: boolean;
}

export function parseActivatedRuntimeJobPayload(
  value: unknown,
): ActivatedRuntimeJobPayload | undefined {
  if (!value || typeof value !== "object") return undefined;
  const payload = value as Partial<ActivatedRuntimeJobPayload>;
  if (
    payload.schemaVersion !== 1 ||
    (payload.activation !== "manual" && payload.activation !== "event") ||
    typeof payload.turnId !== "string" ||
    typeof payload.expectedSessionIncarnation !== "string" ||
    typeof payload.expectedApprovalScope !== "string" ||
    typeof payload.locale !== "string"
  ) {
    return undefined;
  }
  if (
    payload.activation === "event" &&
    (!payload.triggerEvent ||
      typeof payload.triggerEvent.topic !== "string" ||
      !payload.triggerEvent.data ||
      typeof payload.triggerEvent.data !== "object")
  ) {
    return undefined;
  }
  return payload as ActivatedRuntimeJobPayload;
}

/** Session incarnation a queued job was admitted under, for either payload kind. */
export function runtimeJobIncarnation(value: unknown): string | undefined {
  return (
    parseStagedRuntimeJobPayload(value) ??
    parseActivatedRuntimeJobPayload(value)
  )?.expectedSessionIncarnation;
}

export interface RuntimeJobExecutionControl {
  /** Checked after same-runtime serialization, before any provider call. */
  assertCurrent(): Promise<void>;
  /** Cooperative deadline signal threaded into the runtime execution. */
  readonly signal: AbortSignal;
  /** Called under the session commit lock immediately before domain commit. */
  beforeCommit(args: {
    readonly backgroundTurnId: string;
    readonly backgroundExecutionId: string;
  }): Promise<void>;
  /** Persist success in the same transaction as every domain write. */
  completeInTx(tx: StoreTransaction, result?: unknown): Promise<void>;
  /**
   * Persist a failure the runtime reported in its own result. The domain
   * writes still commit with it (a handler may record its own failure state).
   */
  failInTx(
    tx: StoreTransaction,
    failure: {
      readonly reason: RuntimeJobReportedFailure;
      readonly error: string;
      readonly result?: unknown;
    },
  ): Promise<void>;
}

/** Failures settled inside the commit rather than by rolling it back. */
export type RuntimeJobReportedFailure =
  "runtime-reported-failure" | "follower-not-emitted";

const REPORTED_FAILURES: ReadonlySet<string> = new Set([
  "runtime-reported-failure",
  "follower-not-emitted",
]);

export type RuntimeJobExecutor = (
  job: RuntimeJobRecord,
  control: RuntimeJobExecutionControl,
) => Promise<void>;

export interface RuntimeJobWorker {
  /**
   * Signal that newly committed queue rows may be available in `sessionId`.
   * Without a session the next pass scans every session.
   */
  wake(sessionId?: string): void;
  /** Stop claiming, cancel uncommitted work, and await worker-owned storage operations. */
  close(): Promise<void>;
  readonly activeCount: number;
}

export class RuntimeJobNoLongerCurrentError extends Error {
  constructor() {
    super("detached runtime job is no longer current");
    this.name = "RuntimeJobNoLongerCurrentError";
  }
}

class RuntimeJobExecutionTimedOutError extends Error {
  constructor(readonly maxExecutionMs: number) {
    super(`detached runtime job exceeded ${maxExecutionMs}ms execution limit`);
    this.name = "RuntimeJobExecutionTimedOutError";
  }
}

class RuntimeJobWorkerClosedError extends Error {
  constructor() {
    super("runtime job worker is shutting down");
    this.name = "RuntimeJobWorkerClosedError";
  }
}

function publicState(status: RuntimeJobStatus): JobStatusState {
  switch (status) {
    case "queued":
      return "queued";
    case "claimed":
    case "running":
      return "running";
    case "committing":
      return "progress";
    case "succeeded":
      return "succeeded";
    case "cancelled":
      return "cancelled";
    case "failed":
    case "timed_out":
    case "stale":
    case "orphaned":
      return "failed";
  }
}

function publicProgress(status: RuntimeJobStatus): number {
  switch (status) {
    case "queued":
      return 0;
    case "claimed":
      return 5;
    case "running":
      return 10;
    case "committing":
      return 95;
    default:
      return 100;
  }
}

export function makeRuntimeJobStatusRecord(
  job: RuntimeJobRecord,
  sequence: number,
): JobStatusRecord {
  const diagnostics = publicRuntimeJobDiagnostics(job);
  return {
    sessionId: job.sessionId,
    // Control-plane jobs own an independent scope. Reusing the source
    // execution id would make finalizeExecution mistake the queued record for
    // a handler-reported progress job and terminalize it with the foreground
    // turn before the detached worker even starts.
    progressScopeId: job.jobId,
    pluginId: job.pluginId,
    runtimeId: job.runtimeId,
    jobId: job.jobId,
    state: publicState(job.status),
    progress: publicProgress(job.status),
    ...(diagnostics.error ? { message: diagnostics.error } : {}),
    data: {
      originTurnId: job.origin.sourceTurnId,
      durableStatus: job.status,
      ...diagnostics,
    },
    sequence,
    createdAt: job.updatedAt,
  };
}

export function publishRuntimeJobStatusEvent(
  eventBus: EventBus,
  record: JobStatusRecord,
): void {
  eventBus.emit({
    id: crypto.randomUUID(),
    type: "event",
    topic: "job",
    sessionId: record.sessionId,
    timestamp: record.createdAt,
    payload: {
      ...record,
      _subTopic: "job",
      _subType: "job-status.updated",
    },
  });
}

/**
 * A job-status row projects one job of one session incarnation. It may be
 * written only while that job and that incarnation exist, so a deleted or
 * re-created session never receives rows of the session that used to hold its
 * id.
 */
async function ownsRuntimeJobProjection(
  store: Pick<StoreTransaction, "getSession" | "getPluginData">,
  job: RuntimeJobRecord,
): Promise<boolean> {
  const session = await store.getSession(job.sessionId);
  if (!session || session.metadata?.[SESSION_DELETION_PENDING_KEY])
    return false;
  const admitted = runtimeJobIncarnation(job.payload);
  if (
    admitted !== undefined &&
    admitted !==
      `incarnation:${String(session.metadata?.[SESSION_INCARNATION_KEY])}`
  )
    return false;
  return (await getRuntimeJob(store, job)) !== null;
}

/**
 * Project a job's durable state as a job-status row and announce it.
 *
 * The ownership check and the write are one transaction, so session deletion
 * cannot land between them, whichever lock the caller holds: the worker
 * projects a claim before any runtime or session lock is taken. Memory and
 * SQLite queue the delete behind the open transaction; PostgreSQL holds the
 * session row, which the delete cascade locks first. The event is published
 * only for a row that committed.
 */
export async function appendRuntimeJobStatus(
  store: Pick<DataStore, "withTransaction">,
  eventBus: EventBus,
  job: RuntimeJobRecord,
): Promise<void> {
  const record = await store.withTransaction(async (tx) => {
    try {
      // The dimension writers' session barrier: a row lock on PostgreSQL.
      await tx.compareAndSetPluginDataBatch(job.sessionId, job.pluginId, []);
    } catch (error) {
      // The session row was gone, or replaced, when PostgreSQL granted the
      // lock: this job's session no longer exists. Any other failure is the
      // database's, and reaches the caller as it was raised.
      if (error instanceof SessionNotFoundError) return undefined;
      throw error;
    }
    if (!(await ownsRuntimeJobProjection(tx, job))) return undefined;
    const existing = await tx.listJobStatus(job.sessionId, {
      progressScopeId: job.jobId,
      jobId: job.jobId,
    });
    const own = existing.filter(
      (row) => row.pluginId === job.pluginId && row.runtimeId === job.runtimeId,
    );
    const next = makeRuntimeJobStatusRecord(
      job,
      (own.at(-1)?.sequence ?? -1) + 1,
    );
    return (await tx.appendJobStatus(next)) ? next : undefined;
  });
  if (record) publishRuntimeJobStatusEvent(eventBus, record);
}

function runtimeKey(job: RuntimeJobRecord): string {
  return `${job.sessionId}\u0000${job.pluginId}\u0000${job.runtimeId}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Durable, bounded worker for scheduler-detached runtime stages.
 *
 * Queue ownership is a renewable CAS lease. Domain output can commit only
 * after `beforeCommit` advances the durable row from `running` to
 * `committing`; cancellation, timeout, revocation, or another owner therefore
 * makes a late provider response harmless.
 */
export function createRuntimeJobWorker(args: {
  readonly store: DataStore;
  readonly eventBus: EventBus;
  readonly tryWithCommitLock: NonNullable<SessionLock["tryWithLock"]>;
  readonly execute: RuntimeJobExecutor;
  /**
   * Capture request services before claiming. A missing executor leaves the
   * job queued; a captured closure remains valid if the handoff TTL expires.
   */
  readonly prepareExecution?: (
    job: RuntimeJobRecord,
  ) => RuntimeJobExecutor | undefined | Promise<RuntimeJobExecutor | undefined>;
  /** Resolve credential readiness before claiming; never persist request secrets. */
  readonly canExecute?: (job: RuntimeJobRecord) => boolean | Promise<boolean>;
  readonly concurrency?: number;
  readonly leaseMs?: number;
  readonly ownerId?: string;
}): RuntimeJobWorker {
  if (typeof args.tryWithCommitLock !== "function") {
    throw new TypeError(
      "runtime job worker requires a nonblocking commit lock",
    );
  }
  const concurrency = args.concurrency ?? DEFAULT_CONCURRENCY;
  const leaseMs = args.leaseMs ?? DEFAULT_LEASE_MS;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new RangeError("runtime job worker concurrency must be positive");
  }
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) {
    throw new RangeError("runtime job worker leaseMs must be positive");
  }

  const ownerId = args.ownerId ?? crypto.randomUUID();
  const activeRuntimeKeys = new Set<string>();
  let activeCount = 0;
  let sessionCursor: string | undefined;
  let scheduled: ReturnType<typeof setImmediate> | undefined;
  let draining: Promise<void> | undefined;
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  let nextMaintenanceAt = 0;
  // Between maintenance passes a drain claims only from sessions named by
  // wake(). A wake without a session, and every maintenance pass, scans all
  // sessions, which also picks up work another process queued.
  const hintedSessions = new Set<string>();
  let fullScanRequested = false;
  let wakeRequested = false;
  let closed = false;
  let closing: Promise<void> | undefined;
  const activeTasks = new Set<Promise<void>>();
  const executions = new Set<Promise<void>>();
  const stopExecutions = new Set<() => void>();

  const transition = async (
    job: RuntimeJobRecord,
    from: readonly RuntimeJobStatus[],
    to: RuntimeJobStatus,
    extra: {
      readonly backgroundTurnId?: string;
      readonly backgroundExecutionId?: string;
      readonly result?: unknown;
      readonly error?: string;
      readonly reason?: string;
    } = {},
  ): Promise<RuntimeJobRecord | null> => {
    const changed = await transitionRuntimeJob(args.store, {
      sessionId: job.sessionId,
      pluginId: job.pluginId,
      jobId: job.jobId,
      from,
      to,
      ownerId,
      ...extra,
    });
    if (changed)
      await appendRuntimeJobStatus(args.store, args.eventBus, changed);
    return changed;
  };

  const runOne = async (
    claimed: RuntimeJobRecord,
    execute: RuntimeJobExecutor,
  ): Promise<void> => {
    let current = claimed;
    let renewalTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let stopRenewing = false;
    // Distinguishes "rejected before the commit barrier" (stale input,
    // pre-execution validation) from "rejected at the commit barrier".
    let commitBarrierReached = false;
    const executionAbort = new AbortController();
    let renewalTask: Promise<void> | undefined;
    let deadlineTask: Promise<void> | undefined;
    let onAbort: (() => void) | undefined;
    const stop = (): void => {
      // A job that crossed the commit barrier must finish settling its durable
      // outcome. Cancellation before that barrier can never authorize replay.
      if (current.status !== "committing") {
        executionAbort.abort(new RuntimeJobWorkerClosedError());
      }
    };
    stopExecutions.add(stop);
    if (closed) stop();

    const stopLeaseRenewal = async (): Promise<void> => {
      stopRenewing = true;
      if (renewalTimer) clearTimeout(renewalTimer);
      // The lease and lifecycle share one CAS revision. Drain this owner's
      // in-flight renewal before changing lifecycle state.
      await renewalTask;
    };

    const scheduleRenewal = (): void => {
      if (stopRenewing) return;
      renewalTimer = setTimeout(
        () => {
          renewalTask = (async () => {
            if (stopRenewing) return;
            try {
              const renewed = await renewRuntimeJobLease(args.store, {
                sessionId: current.sessionId,
                pluginId: current.pluginId,
                jobId: current.jobId,
                ownerId,
                leaseMs,
              });
              if (!renewed) {
                const shouldAbort = !stopRenewing;
                stopRenewing = true;
                if (shouldAbort) {
                  executionAbort.abort(new RuntimeJobNoLongerCurrentError());
                }
                return;
              }
              if (stopRenewing) return;
              current = renewed;
              scheduleRenewal();
            } catch (error) {
              console.warn(
                `[runtime-job-worker] lease renewal failed for ${current.jobId}:`,
                errorMessage(error),
              );
              scheduleRenewal();
            }
          })();
        },
        Math.max(1, Math.floor(leaseMs / 3)),
      );
      renewalTimer.unref?.();
    };

    try {
      executionAbort.signal.throwIfAborted();
      await appendRuntimeJobStatus(args.store, args.eventBus, claimed);
      const running = await transition(current, ["claimed"], "running");
      if (!running) return;
      current = running;
      executionAbort.signal.throwIfAborted();
      scheduleRenewal();

      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(executionAbort.signal.reason);
        executionAbort.signal.addEventListener("abort", onAbort, {
          once: true,
        });
      });
      if (current.maxExecutionMs !== undefined) {
        timeoutTimer = setTimeout(() => {
          deadlineTask = (async () => {
            await stopLeaseRenewal();
            const timedOut = await transition(
              current,
              ["running"],
              "timed_out",
              {
                reason: "execution-deadline-exceeded",
                error: `execution exceeded ${current.maxExecutionMs}ms`,
              },
            ).catch(() => null);
            if (timedOut) {
              const error = new RuntimeJobExecutionTimedOutError(
                current.maxExecutionMs!,
              );
              executionAbort.abort(error);
            }
          })();
        }, current.maxExecutionMs);
        timeoutTimer.unref?.();
      }

      const execution = execute(current, {
        signal: executionAbort.signal,
        assertCurrent: async () => {
          executionAbort.signal.throwIfAborted();
          const live = await getRuntimeJob(args.store, current);
          executionAbort.signal.throwIfAborted();
          if (!live || live.status !== "running" || live.ownerId !== ownerId) {
            throw new RuntimeJobNoLongerCurrentError();
          }
        },
        beforeCommit: async (identity) => {
          executionAbort.signal.throwIfAborted();
          await stopLeaseRenewal();
          executionAbort.signal.throwIfAborted();
          // Mark the barrier before the CAS so a rejection here is durable
          // as "commit-barrier-rejected" rather than "pre-execution-rejected".
          commitBarrierReached = true;
          const committing = await transition(
            current,
            ["running"],
            "committing",
            identity,
          );
          if (!committing) throw new RuntimeJobNoLongerCurrentError();
          current = committing;
          executionAbort.signal.throwIfAborted();
        },
        completeInTx: async (tx, result) => {
          executionAbort.signal.throwIfAborted();
          const succeeded = await transitionRuntimeJob(tx, {
            sessionId: current.sessionId,
            pluginId: current.pluginId,
            jobId: current.jobId,
            ownerId,
            from: ["committing"],
            to: "succeeded",
            ...(result === undefined ? {} : { result }),
          });
          if (!succeeded) throw new RuntimeJobNoLongerCurrentError();
          // This transaction can still roll back. Do not publish status or
          // treat the in-memory job as successful until the executor settles.
        },
        failInTx: async (tx, failure) => {
          executionAbort.signal.throwIfAborted();
          const failed = await transitionRuntimeJob(tx, {
            sessionId: current.sessionId,
            pluginId: current.pluginId,
            jobId: current.jobId,
            ownerId,
            from: ["committing"],
            to: "failed",
            reason: failure.reason,
            error: failure.error,
            ...(failure.result === undefined ? {} : { result: failure.result }),
          });
          if (!failed) throw new RuntimeJobNoLongerCurrentError();
        },
      });
      executions.add(execution);
      void execution.then(
        () => executions.delete(execution),
        () => executions.delete(execution),
      );
      await Promise.race([execution, aborted]);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      const settled = await getRuntimeJob(args.store, current);
      const reportedFailure =
        settled?.status === "failed" &&
        REPORTED_FAILURES.has(settled.reason ?? "");
      if (
        !settled ||
        (settled.status !== "succeeded" && !reportedFailure) ||
        settled.ownerId !== ownerId
      ) {
        throw new Error("runtime job returned without a committed result");
      }
      current = settled;
      await appendRuntimeJobStatus(args.store, args.eventBus, settled);
    } catch (error) {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      await stopLeaseRenewal();
      const stale =
        error instanceof RuntimeJobNoLongerCurrentError ||
        (error instanceof Error &&
          (error.name === "SessionApprovalScopeChangedError" ||
            error.name === "SessionNotActiveError"));
      const shuttingDown = error instanceof RuntimeJobWorkerClosedError;
      const terminal = await transition(
        current,
        ["claimed", "running", "committing"],
        shuttingDown ? "cancelled" : stale ? "stale" : "failed",
        {
          reason: shuttingDown
            ? "worker-shutdown"
            : stale
              ? commitBarrierReached
                ? "commit-barrier-rejected"
                : "pre-execution-rejected"
              : "execution-failed",
          error: errorMessage(error),
        },
      ).catch((transitionError) =>
        console.warn(
          `[runtime-job-worker] failed to terminalize ${current.jobId}:`,
          errorMessage(transitionError),
        ),
      );
      if (terminal === null && !stale && !shuttingDown) {
        console.warn("[runtime-job-worker] completion follow-up failed", {
          sessionId: current.sessionId,
          jobId: current.jobId,
        });
      }
    } finally {
      stopRenewing = true;
      if (renewalTimer) clearTimeout(renewalTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (onAbort) executionAbort.signal.removeEventListener("abort", onAbort);
      await Promise.allSettled([renewalTask, deadlineTask]);
      stopExecutions.delete(stop);
      touchedSessions.add(claimed.sessionId);
      activeRuntimeKeys.delete(runtimeKey(claimed));
      activeCount--;
      wake(claimed.sessionId);
    }
  };

  // The first pass after startup reconciles every retained terminal job; later
  // passes only revisit jobs finished since the previous successful pass.
  let reconciledThrough: number | undefined;
  const touchedSessions = new Set<string>();
  const reconcileTerminalJobs = async (
    scope: "all" | "touched",
  ): Promise<void> => {
    // Durable state can outlive its event projection after a crash or a
    // failed notification. Reconcile it independently of execution capacity.
    const startedAt = Date.now();
    const since =
      reconciledThrough === undefined
        ? -Infinity
        : reconciledThrough - RECONCILE_OVERLAP_MS;
    const sessionIds =
      scope === "all"
        ? (await args.store.listSessions()).map((session) => session.id)
        : [...touchedSessions];
    touchedSessions.clear();
    for (const sessionId of sessionIds) {
      if (closed) return;
      const terminal = await pruneTerminalRuntimeJobs(
        args.store,
        sessionId,
        await listRuntimeJobs(args.store, {
          sessionId,
          statuses: [
            "succeeded",
            "failed",
            "timed_out",
            "cancelled",
            "stale",
            "orphaned",
          ],
        }),
      );
      for (const job of terminal) {
        if (closed) return;
        if (Date.parse(job.finishedAt ?? job.updatedAt) < since) continue;
        const rows = await args.store.listJobStatus(job.sessionId, {
          progressScopeId: job.jobId,
          jobId: job.jobId,
        });
        const latest = rows.at(-1);
        const durableStatus =
          latest?.data &&
          typeof latest.data === "object" &&
          !Array.isArray(latest.data)
            ? (latest.data as Readonly<Record<string, JsonValue>>).durableStatus
            : undefined;
        if (durableStatus !== job.status) {
          await appendRuntimeJobStatus(args.store, args.eventBus, job);
        }
      }
    }
    // Only a complete pass advances the watermark: a touched-session pass does
    // not see jobs terminalised elsewhere (queue deadlines, other workers).
    if (scope === "all") reconciledThrough = startedAt;
  };

  const drain = async (): Promise<void> => {
    let maintained = false;
    if (!closed && Date.now() >= nextMaintenanceAt) {
      try {
        await recoverExpiredRuntimeJobs(args.store, {
          tryWithCommitLock: args.tryWithCommitLock,
        });
        await reconcileTerminalJobs("all");
        maintained = true;
        nextMaintenanceAt = Date.now() + MAINTENANCE_INTERVAL_MS;
      } catch (error) {
        nextMaintenanceAt = Date.now() + DRAIN_RETRY_MS;
        throw error;
      }
    }

    const scope =
      maintained || fullScanRequested ? undefined : [...hintedSessions];
    fullScanRequested = false;
    hintedSessions.clear();
    if (scope?.length === 0) {
      if (!maintained) await reconcileTerminalJobs("touched");
      return;
    }

    while (!closed) {
      if (activeCount >= concurrency) {
        // A finishing job wakes the worker; resume this pass's scope then.
        if (scope) for (const sessionId of scope) hintedSessions.add(sessionId);
        else fullScanRequested = true;
        return;
      }
      let prepared: RuntimeJobExecutor | undefined;
      const claimed = await claimNextRuntimeJob(args.store, {
        ownerId,
        leaseMs,
        ...(scope ? { sessionIds: scope } : {}),
        ...(sessionCursor ? { afterSessionId: sessionCursor } : {}),
        excludeRuntimeKeys: activeRuntimeKeys,
        canClaim: async (job) => {
          prepared = undefined;
          if (args.canExecute && !(await args.canExecute(job))) return false;
          prepared = args.prepareExecution
            ? await args.prepareExecution(job)
            : args.execute;
          return prepared !== undefined;
        },
      });
      if (!claimed) {
        if (!maintained) await reconcileTerminalJobs("touched");
        return;
      }
      sessionCursor = claimed.nextSessionCursor;
      activeCount++;
      activeRuntimeKeys.add(runtimeKey(claimed.job));
      const task = runOne(claimed.job, prepared!);
      activeTasks.add(task);
      void task.then(() => activeTasks.delete(task));
    }
  };

  function wake(sessionId?: string): void {
    if (closed) return;
    if (sessionId === undefined) fullScanRequested = true;
    else hintedSessions.add(sessionId);
    schedule();
  }

  function schedule(): void {
    if (closed) return;
    if (draining) {
      wakeRequested = true;
      return;
    }
    if (scheduled) return;
    if (wakeTimer) clearTimeout(wakeTimer);
    scheduled = setImmediate(() => {
      scheduled = undefined;
      let retryDrain = false;
      draining = drain()
        .catch(() => {
          retryDrain = true;
          // The failed pass may have consumed session hints.
          fullScanRequested = true;
          console.warn("[runtime-job-worker] drain failed; retry scheduled");
        })
        .finally(() => {
          draining = undefined;
          if (closed) return;
          if (wakeRequested) {
            wakeRequested = false;
            schedule();
            return;
          }
          const untilMaintenance = Math.max(1, nextMaintenanceAt - Date.now());
          wakeTimer = setTimeout(
            () => {
              wakeTimer = undefined;
              schedule();
            },
            retryDrain
              ? Math.min(DRAIN_RETRY_MS, untilMaintenance)
              : untilMaintenance,
          );
          wakeTimer.unref?.();
        });
    });
  }

  return {
    wake,
    close() {
      if (closing) return closing;
      closed = true;
      if (scheduled) clearImmediate(scheduled);
      if (wakeTimer) clearTimeout(wakeTimer);
      for (const stop of stopExecutions) stop();
      closing = (async () => {
        // An in-flight claim may return after close. runOne sees closed and
        // settles that claim without starting a provider call.
        await draining;
        await Promise.allSettled(activeTasks);
        // The runtime cooperates with cancellation. Its outer runner may still
        // be releasing locks or finishing a pending store read after the race.
        await Promise.allSettled(executions);
      })();
      return closing;
    },
    get activeCount() {
      return activeCount;
    },
  };
}
