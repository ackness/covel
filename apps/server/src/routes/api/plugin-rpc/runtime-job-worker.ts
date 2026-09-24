import type { EventBus } from "@covel/events";
import type { DataStore, StoreTransaction } from "@covel/store";
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
  recoverExpiredRuntimeJobs,
  renewRuntimeJobLease,
  transitionRuntimeJob,
  type RuntimeJobRecord,
  type RuntimeJobStatus,
} from "./jobs.js";
import { publicRuntimeJobDiagnostics } from "./runtime-job-public.js";

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_LEASE_MS = 120_000;
const DRAIN_RETRY_MS = 1_000;
const MAINTENANCE_INTERVAL_MS = 30_000;

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
  return payload as StagedRuntimeJobPayload;
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
}

export interface RuntimeJobWorker {
  /** Signal that newly committed queue rows may be available. */
  wake(): void;
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

export class RuntimeJobExecutionTimedOutError extends Error {
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

export async function appendRuntimeJobStatus(
  store: Pick<DataStore, "appendJobStatus" | "listJobStatus">,
  eventBus: EventBus,
  job: RuntimeJobRecord,
): Promise<void> {
  const existing = await store.listJobStatus(job.sessionId, {
    progressScopeId: job.jobId,
    jobId: job.jobId,
  });
  const own = existing.filter(
    (record) =>
      record.pluginId === job.pluginId && record.runtimeId === job.runtimeId,
  );
  const sequence = (own.at(-1)?.sequence ?? -1) + 1;
  const record = makeRuntimeJobStatusRecord(job, sequence);
  if (await store.appendJobStatus(record)) {
    publishRuntimeJobStatusEvent(eventBus, record);
  }
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
  readonly execute: (
    job: RuntimeJobRecord,
    control: RuntimeJobExecutionControl,
  ) => Promise<void>;
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

  const runOne = async (claimed: RuntimeJobRecord): Promise<void> => {
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

      const execution = args.execute(current, {
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
      });
      executions.add(execution);
      void execution.then(
        () => executions.delete(execution),
        () => executions.delete(execution),
      );
      await Promise.race([execution, aborted]);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      const succeeded = await getRuntimeJob(args.store, current);
      if (succeeded?.status !== "succeeded" || succeeded.ownerId !== ownerId) {
        throw new Error("runtime job returned without a committed result");
      }
      current = succeeded;
      await appendRuntimeJobStatus(args.store, args.eventBus, succeeded);
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
      activeRuntimeKeys.delete(runtimeKey(claimed));
      activeCount--;
      wake();
    }
  };

  const reconcileTerminalJobs = async (): Promise<void> => {
    // Durable state can outlive its event projection after a crash or a
    // failed notification. Reconcile it independently of execution capacity.
    for (const session of await args.store.listSessions()) {
      if (closed) return;
      const terminal = await listRuntimeJobs(args.store, {
        sessionId: session.id,
        statuses: [
          "succeeded",
          "failed",
          "timed_out",
          "cancelled",
          "stale",
          "orphaned",
        ],
      });
      for (const job of terminal) {
        if (closed) return;
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
  };

  const drain = async (): Promise<void> => {
    let maintained = false;
    if (!closed && Date.now() >= nextMaintenanceAt) {
      try {
        await recoverExpiredRuntimeJobs(args.store, {
          tryWithCommitLock: args.tryWithCommitLock,
        });
        await reconcileTerminalJobs();
        maintained = true;
        nextMaintenanceAt = Date.now() + MAINTENANCE_INTERVAL_MS;
      } catch (error) {
        nextMaintenanceAt = Date.now() + DRAIN_RETRY_MS;
        throw error;
      }
    }

    while (!closed && activeCount < concurrency) {
      const claimed = await claimNextRuntimeJob(args.store, {
        ownerId,
        leaseMs,
        ...(sessionCursor ? { afterSessionId: sessionCursor } : {}),
        excludeRuntimeKeys: activeRuntimeKeys,
      });
      if (!claimed) {
        if (!maintained) await reconcileTerminalJobs();
        return;
      }
      sessionCursor = claimed.nextSessionCursor;
      activeCount++;
      activeRuntimeKeys.add(runtimeKey(claimed.job));
      const task = runOne(claimed.job);
      activeTasks.add(task);
      void task.then(() => activeTasks.delete(task));
    }
  };

  function wake(): void {
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
          console.warn("[runtime-job-worker] drain failed; retry scheduled");
        })
        .finally(() => {
          draining = undefined;
          if (closed) return;
          if (wakeRequested) {
            wakeRequested = false;
            wake();
            return;
          }
          const untilMaintenance = Math.max(1, nextMaintenanceAt - Date.now());
          wakeTimer = setTimeout(
            () => {
              wakeTimer = undefined;
              wake();
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
