import type { EventBus } from "@covel/events";
import type { DataStore } from "@covel/store";
import type {
  DeferredRuntimeJob,
  JobStatusRecord,
  JobStatusState,
  JsonValue,
} from "@covel/shared";

import {
  claimNextRuntimeJob,
  getRuntimeJob,
  listRuntimeJobs,
  renewRuntimeJobLease,
  transitionRuntimeJob,
  type RuntimeJobRecord,
  type RuntimeJobStatus,
} from "./jobs.js";

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_LEASE_MS = 120_000;
const DRAIN_RETRY_MS = 1_000;

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
}

export interface RuntimeJobExecutionResult {
  readonly result?: unknown;
}

export interface RuntimeJobWorker {
  /** Signal that newly committed queue rows may be available. */
  wake(): void;
  /** Stop claiming work. Active executions settle normally. Intended for tests/shutdown. */
  close(): void;
  readonly activeCount: number;
}

export class RuntimeJobNoLongerCurrentError extends Error {
  constructor() {
    super("detached runtime job is no longer current at the commit barrier");
    this.name = "RuntimeJobNoLongerCurrentError";
  }
}

export class RuntimeJobExecutionTimedOutError extends Error {
  constructor(readonly maxExecutionMs: number) {
    super(`detached runtime job exceeded ${maxExecutionMs}ms execution limit`);
    this.name = "RuntimeJobExecutionTimedOutError";
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

function statusData(job: RuntimeJobRecord): JsonValue {
  return {
    originTurnId: job.origin.sourceTurnId,
    durableStatus: job.status,
    ...(job.reason ? { reason: job.reason } : {}),
    ...(job.error ? { error: job.error } : {}),
  };
}

export function makeRuntimeJobStatusRecord(
  job: RuntimeJobRecord,
  sequence: number,
): JobStatusRecord {
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
    ...((job.reason ?? job.error) ? { message: job.reason ?? job.error } : {}),
    data: statusData(job),
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
  readonly execute: (
    job: RuntimeJobRecord,
    control: RuntimeJobExecutionControl,
  ) => Promise<RuntimeJobExecutionResult>;
  readonly concurrency?: number;
  readonly leaseMs?: number;
  readonly ownerId?: string;
}): RuntimeJobWorker {
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
  let scheduled = false;
  let closed = false;

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
    const executionAbort = new AbortController();

    const scheduleRenewal = (): void => {
      if (stopRenewing) return;
      renewalTimer = setTimeout(
        async () => {
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
            current = renewed;
            scheduleRenewal();
          } catch (error) {
            console.warn(
              `[runtime-job-worker] lease renewal failed for ${current.jobId}:`,
              errorMessage(error),
            );
            scheduleRenewal();
          }
        },
        Math.max(1, Math.floor(leaseMs / 3)),
      );
      renewalTimer.unref?.();
    };

    try {
      const running = await transition(current, ["claimed"], "running");
      if (!running) return;
      current = running;
      scheduleRenewal();

      let rejectTimeout: ((error: Error) => void) | undefined;
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        rejectTimeout = reject;
      });
      if (current.maxExecutionMs !== undefined) {
        timeoutTimer = setTimeout(async () => {
          const timedOut = await transition(current, ["running"], "timed_out", {
            reason: "execution-deadline-exceeded",
            error: `execution exceeded ${current.maxExecutionMs}ms`,
          }).catch(() => null);
          if (timedOut) {
            const error = new RuntimeJobExecutionTimedOutError(
              current.maxExecutionMs!,
            );
            executionAbort.abort(error);
            rejectTimeout?.(error);
          }
        }, current.maxExecutionMs);
        timeoutTimer.unref?.();
      }

      const execution = args.execute(current, {
        signal: executionAbort.signal,
        assertCurrent: async () => {
          const live = await getRuntimeJob(args.store, current);
          if (!live || live.status !== "running" || live.ownerId !== ownerId) {
            throw new RuntimeJobNoLongerCurrentError();
          }
        },
        beforeCommit: async (identity) => {
          stopRenewing = true;
          if (renewalTimer) clearTimeout(renewalTimer);
          const committing = await transition(
            current,
            ["running"],
            "committing",
            identity,
          );
          if (!committing) throw new RuntimeJobNoLongerCurrentError();
          current = committing;
        },
      });
      const result = current.maxExecutionMs
        ? await Promise.race([execution, timeoutPromise])
        : await execution;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      const succeeded = await transition(
        current,
        ["committing"],
        "succeeded",
        result.result === undefined ? {} : { result: result.result },
      );
      if (!succeeded) {
        throw new RuntimeJobNoLongerCurrentError();
      }
    } catch (error) {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      const stale =
        error instanceof RuntimeJobNoLongerCurrentError ||
        (error instanceof Error &&
          (error.name === "SessionApprovalScopeChangedError" ||
            error.name === "SessionNotActiveError"));
      await transition(
        current,
        ["claimed", "running", "committing"],
        stale ? "stale" : "failed",
        {
          reason: stale ? "commit-barrier-rejected" : "execution-failed",
          error: errorMessage(error),
        },
      ).catch((transitionError) =>
        console.warn(
          `[runtime-job-worker] failed to terminalize ${current.jobId}:`,
          errorMessage(transitionError),
        ),
      );
    } finally {
      stopRenewing = true;
      if (renewalTimer) clearTimeout(renewalTimer);
      activeRuntimeKeys.delete(runtimeKey(claimed));
      activeCount--;
      wake();
    }
  };

  const drain = async (): Promise<void> => {
    scheduled = false;
    if (closed) return;
    while (activeCount < concurrency) {
      const claimed = await claimNextRuntimeJob(args.store, {
        ownerId,
        leaseMs,
        ...(sessionCursor ? { afterSessionId: sessionCursor } : {}),
        excludeRuntimeKeys: activeRuntimeKeys,
      });
      if (!claimed) {
        // claimRuntimeJob and the startup recovery sweep can terminalize work
        // without owning an EventBus. Reconcile those durable states once the
        // runnable queue is empty so live clients never keep a stale spinner.
        for (const session of await args.store.listSessions()) {
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
            const rows = await args.store.listJobStatus(job.sessionId, {
              progressScopeId: job.jobId,
              jobId: job.jobId,
            });
            const latest = rows.at(-1);
            const durableStatus =
              latest?.data &&
              typeof latest.data === "object" &&
              !Array.isArray(latest.data)
                ? (latest.data as Readonly<Record<string, JsonValue>>)
                    .durableStatus
                : undefined;
            if (durableStatus !== job.status) {
              await appendRuntimeJobStatus(args.store, args.eventBus, job);
            }
          }
        }
        return;
      }
      sessionCursor = claimed.nextSessionCursor;
      activeCount++;
      activeRuntimeKeys.add(runtimeKey(claimed.job));
      await appendRuntimeJobStatus(args.store, args.eventBus, claimed.job);
      void runOne(claimed.job);
    }
  };

  function wake(): void {
    if (closed || scheduled) return;
    scheduled = true;
    setImmediate(() => {
      void drain().catch((error) => {
        scheduled = false;
        console.warn("[runtime-job-worker] drain failed:", errorMessage(error));
        if (!closed) {
          const retryTimer = setTimeout(wake, DRAIN_RETRY_MS);
          retryTimer.unref?.();
        }
      });
    });
  }

  return {
    wake,
    close() {
      closed = true;
    },
    get activeCount() {
      return activeCount;
    },
  };
}
