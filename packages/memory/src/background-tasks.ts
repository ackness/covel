/**
 * Process-wide registry for post-turn memory work.
 *
 * Turn completion deliberately does not await core-memory extraction or vector
 * ingestion. Registering both kinds of work here gives graceful shutdown one
 * barrier that can drain every memory system created in this process without
 * coupling the server composition root to an individual session.
 */

export type MemoryBackgroundTaskKind = "core-update" | "vector-ingest";

export interface MemoryBackgroundTaskInfo {
  readonly kind: MemoryBackgroundTaskKind;
  readonly sessionId: string;
}

export interface MemoryBackgroundDrainResult {
  readonly awaited: number;
  readonly rejected: number;
  readonly failures: readonly string[];
}

interface PendingTask extends MemoryBackgroundTaskInfo {
  readonly promise: Promise<unknown>;
}

const pendingTasks = new Set<PendingTask>();

/** Register work without changing the promise observed by its caller. */
export function trackMemoryBackgroundTask<T>(
  promise: Promise<T>,
  info: MemoryBackgroundTaskInfo,
): Promise<T> {
  const entry: PendingTask = { ...info, promise };
  pendingTasks.add(entry);
  void promise.then(
    () => pendingTasks.delete(entry),
    () => pendingTasks.delete(entry),
  );
  return promise;
}

/** Number of memory tasks that have not settled yet. Primarily for diagnostics. */
export function pendingMemoryBackgroundTaskCount(): number {
  return pendingTasks.size;
}

/**
 * Wait for every task currently registered, including tasks registered while
 * the barrier is draining. Rejections are collected instead of failing fast so
 * one provider failure cannot prevent another session's memory from flushing.
 * The caller owns the timeout policy (the server shutdown path time-boxes it).
 */
export async function awaitPendingMemoryBackgroundTasks(): Promise<MemoryBackgroundDrainResult> {
  let awaited = 0;
  let rejected = 0;
  const failures: string[] = [];

  while (pendingTasks.size > 0) {
    const batch = [...pendingTasks];
    awaited += batch.length;
    const results = await Promise.allSettled(
      batch.map((entry) => entry.promise),
    );
    for (let i = 0; i < results.length; i += 1) {
      const result = results[i];
      if (result.status === "fulfilled") continue;
      rejected += 1;
      const task = batch[i];
      failures.push(
        `${task.kind}:${task.sessionId}: ${errorMessage(result.reason)}`,
      );
    }
  }

  return { awaited, rejected, failures };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
