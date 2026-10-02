import { AsyncLocalStorage } from "node:async_hooks";
import { MAX_SETTLE_WAIT_MS } from "@covel/shared";
import type { SessionLock } from "../../../lib/session-lock.js";

export interface SettlingJob {
  readonly jobId: string;
  readonly maxSettleWaitMs?: number;
}

export interface SettleTimeout {
  readonly pendingJobIds: readonly string[];
  readonly waitedMs: number;
}

/** Reused when an entry point must release other locks and retry admission. */
export interface SettleWaitBudget {
  readonly startedAt: number;
  deadline: number;
}

export interface SettledSessionLockOptions {
  readonly waitBudget?: SettleWaitBudget;
  readonly signal?: AbortSignal;
  readonly provideCredentials?: (
    jobs: readonly SettlingJob[],
  ) => void | Promise<void>;
  readonly onTimeout?: (timeout: SettleTimeout) => void | Promise<void>;
}

export interface SettledSessionLock {
  withLock<T>(
    sessionId: string,
    options: SettledSessionLockOptions,
    fn: () => Promise<T>,
  ): Promise<T>;
}

const DEFAULT_SETTLE_WAIT_MS = 60_000;
/** Durable polling backs off so a long wait does not query every tick. */
const MAX_POLL_INTERVAL_MS = 250;
const RETRY = Symbol("retry after releasing the session lock");

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Cancel acquisition promptly, but never detach a callback that already began. */
function acquire<T>(
  lock: SessionLock,
  sessionId: string,
  signal: AbortSignal | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return lock.withLock(sessionId, fn);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void lock
      .withLock(sessionId, async () => {
        signal.removeEventListener("abort", abort);
        // The caller may already have returned on abort. The late lock owner
        // must release without running the execution callback or any writes.
        signal.throwIfAborted();
        return fn();
      })
      .then(
        (value) => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
  });
}

/**
 * Entry-point barrier. Worker authorization and commits MUST keep using the
 * raw SessionLock, and callers must enter before acquiring runtime/world locks.
 * The durable query, not notifications, determines whether work has settled.
 */
export function createSettledSessionLock(args: {
  readonly sessionLock: SessionLock;
  readonly listPendingJobs: (
    sessionId: string,
  ) => Promise<readonly SettlingJob[]>;
  readonly wake?: (sessionId: string) => void;
  readonly pollIntervalMs?: number;
}): SettledSessionLock {
  const pollIntervalMs = args.pollIntervalMs ?? 25;
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new RangeError("settle pollIntervalMs must be positive");
  }
  const context = new AsyncLocalStorage<
    ReadonlyMap<string, { active: boolean }>
  >();
  return {
    async withLock<T>(
      sessionId: string,
      options: SettledSessionLockOptions,
      fn: () => Promise<T>,
    ): Promise<T> {
      options.signal?.throwIfAborted();
      const parent = context.getStore();
      // A nested framework action is part of the execution already admitted.
      // Rechecking here could wait on work while retaining the outer lock.
      if (parent?.get(sessionId)?.active) return fn();
      const budget = options.waitBudget ?? {
        startedAt: performance.now(),
        deadline: Infinity,
      };
      const startedAt = budget.startedAt;
      const constrainDeadline = (jobs: readonly SettlingJob[]) => {
        for (const job of jobs) {
          const maxWait = job.maxSettleWaitMs ?? DEFAULT_SETTLE_WAIT_MS;
          if (!Number.isFinite(maxWait) || maxWait <= 0) {
            throw new RangeError("maxSettleWaitMs must be positive");
          }
          budget.deadline = Math.min(
            budget.deadline,
            startedAt + Math.min(maxWait, MAX_SETTLE_WAIT_MS),
          );
        }
      };
      let pollDelay = pollIntervalMs;
      for (;;) {
        options.signal?.throwIfAborted();
        const pending = await args.listPendingJobs(sessionId);
        options.signal?.throwIfAborted();
        constrainDeadline(pending);
        if (pending.length > 0) {
          await options.provideCredentials?.(pending);
          options.signal?.throwIfAborted();
          args.wake?.(sessionId);
          const remaining = budget.deadline - performance.now();
          if (remaining > 0) {
            await wait(Math.min(remaining, pollDelay), options.signal);
            pollDelay = Math.min(
              pollDelay * 2,
              Math.max(pollIntervalMs, MAX_POLL_INTERVAL_MS),
            );
            continue;
          }
        }
        const result = await acquire(
          args.sessionLock,
          sessionId,
          options.signal,
          async () => {
            options.signal?.throwIfAborted();
            const live = await args.listPendingJobs(sessionId);
            options.signal?.throwIfAborted();
            constrainDeadline(live);
            if (live.length > 0 && performance.now() < budget.deadline)
              return RETRY;
            if (live.length > 0) {
              await options.onTimeout?.({
                pendingJobIds: live.map((job) => job.jobId),
                waitedMs: Math.max(0, performance.now() - startedAt),
              });
            }
            options.signal?.throwIfAborted();
            const owner = { active: true };
            try {
              return await context.run(
                new Map([...(parent ?? []), [sessionId, owner] as const]),
                fn,
              );
            } finally {
              owner.active = false;
            }
          },
        );
        if (result !== RETRY) return result;
      }
    },
  };
}
