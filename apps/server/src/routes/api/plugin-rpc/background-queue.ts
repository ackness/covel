export class PluginBackgroundQueueClosedError extends Error {
  constructor() {
    super("plugin background queue is shutting down");
    this.name = "PluginBackgroundQueueClosedError";
  }
}

interface BackgroundTask {
  readonly sessionId: string;
  readonly jobId: string;
  /** Persist acceptance before execution; shutdown also owns this write. */
  prepare(): Promise<void>;
  run(signal: AbortSignal): Promise<void>;
  /** Persist an unstarted job's terminal state without executing its runtime. */
  reject(reason: "server-shutdown" | "background-queue-full"): Promise<void>;
}

export interface PluginBackgroundQueue {
  /** Resolves after registration/queueing, not after execution. */
  schedule(task: BackgroundTask): Promise<void>;
  readonly signal: AbortSignal;
  /** Reject new work, abort running work, settle queued work, and drain writes. */
  close(): Promise<void>;
}

/** One bootstrap owns one queue; sessions share its bounded execution slots. */
export function createPluginBackgroundQueue(): PluginBackgroundQueue {
  const concurrency = 4;
  const queueLimit = 1024;
  const controller = new AbortController();
  const owned = new Set<Promise<void>>();
  type Entry = { task: BackgroundTask; finish(): void };
  const queues = new Map<string, Entry[]>();
  let running = 0;
  let queued = 0;
  let lastSessionId: string | undefined;
  let closing: Promise<void> | undefined;

  function reportFailure(task: BackgroundTask): void {
    // Exception messages can contain provider credentials or player content.
    console.error("[plugin-rpc] background task failed to settle", {
      sessionId: task.sessionId,
      jobId: task.jobId,
    });
  }

  function takeNext(): Entry | undefined {
    const sessions = [...queues.keys()].sort();
    if (!sessions.length) return undefined;
    const after = lastSessionId
      ? sessions.findIndex((id) => id > lastSessionId!)
      : 0;
    const sessionId = sessions[after >= 0 ? after : 0]!;
    const entries = queues.get(sessionId)!;
    const next = entries.shift()!;
    if (!entries.length) queues.delete(sessionId);
    queued--;
    lastSessionId = sessionId;
    return next;
  }

  function start(entry: Entry): void {
    // Reserve synchronously so a burst cannot exceed the concurrency limit.
    running++;
    setImmediate(() => {
      void Promise.resolve()
        .then(() =>
          controller.signal.aborted
            ? entry.task.reject("server-shutdown")
            : entry.task.run(controller.signal),
        )
        .catch(() => reportFailure(entry.task))
        .finally(() => {
          running--;
          entry.finish();
          if (!controller.signal.aborted) {
            const next = takeNext();
            if (next) start(next);
          }
        });
    });
  }

  return {
    signal: controller.signal,
    async schedule(task) {
      controller.signal.throwIfAborted();
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      owned.add(finished);
      const entry: Entry = {
        task,
        finish() {
          owned.delete(finished);
          finish();
        },
      };
      try {
        await task.prepare();
        if (
          controller.signal.aborted ||
          (running >= concurrency && queued >= queueLimit)
        ) {
          await task.reject(
            controller.signal.aborted
              ? "server-shutdown"
              : "background-queue-full",
          );
          entry.finish();
        } else if (running < concurrency) {
          start(entry);
        } else {
          const entries = queues.get(task.sessionId) ?? [];
          entries.push(entry);
          queues.set(task.sessionId, entries);
          queued++;
        }
      } catch (error) {
        entry.finish();
        throw error;
      }
    },
    close() {
      if (closing) return closing;
      let resolveClose!: () => void;
      // Publish the promise before abort listeners can re-enter close().
      closing = new Promise<void>((resolve) => {
        resolveClose = resolve;
      });
      controller.abort(new PluginBackgroundQueueClosedError());
      for (const entries of queues.values()) {
        for (const entry of entries) {
          void Promise.resolve()
            .then(() => entry.task.reject("server-shutdown"))
            .catch(() => reportFailure(entry.task))
            .finally(() => entry.finish());
        }
      }
      queues.clear();
      queued = 0;
      // No new admission can join after abort. Includes pending prepare writes,
      // reserved setImmediate callbacks, running work and terminal persistence.
      void Promise.all(owned).then(resolveClose);
      return closing;
    },
  };
}
