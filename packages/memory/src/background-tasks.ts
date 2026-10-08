export interface MemoryBackgroundDrainResult {
  readonly awaited: number;
  readonly rejected: number;
  readonly failures: readonly string[];
}

/** Owned by one MemorySystem; independent server instances never share work. */
export function createMemoryBackgroundTasks() {
  const pending = new Map<Promise<unknown>, string>();
  return {
    track<T>(promise: Promise<T>, sessionId: string): Promise<T> {
      pending.set(promise, sessionId);
      void promise.then(
        () => pending.delete(promise),
        () => pending.delete(promise),
      );
      return promise;
    },
    pendingTaskCount: () => pending.size,
    /** Includes work registered while draining. The host owns timeout policy. */
    async drain(): Promise<MemoryBackgroundDrainResult> {
      let awaited = 0;
      let rejected = 0;
      const failures: string[] = [];
      while (pending.size > 0) {
        const batch = [...pending];
        awaited += batch.length;
        const results = await Promise.allSettled(
          batch.map(([promise]) => promise),
        );
        for (const [i, result] of results.entries()) {
          if (result.status === "fulfilled") continue;
          rejected += 1;
          const error = result.reason;
          failures.push(
            `${batch[i]![1]}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return { awaited, rejected, failures };
    },
  };
}
