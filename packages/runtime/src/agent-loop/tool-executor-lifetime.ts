/** Own callbacks and host I/O after an invocation's caller stops waiting. */
export function createToolExecutorLifetime() {
  const shutdown = new AbortController();
  const pending = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;
  return {
    signal: shutdown.signal,
    assertOpen() {
      shutdown.signal.throwIfAborted();
    },
    track<T>(work: Promise<T>): Promise<T> {
      pending.add(work);
      void work.then(
        () => pending.delete(work),
        () => pending.delete(work),
      );
      return work;
    },
    close(): Promise<void> {
      if (!closing) {
        // Publish before notifying callbacks that may re-enter close().
        closing = Promise.resolve().then(async () => {
          while (pending.size > 0) await Promise.allSettled(pending);
        });
        shutdown.abort(new Error("Tool executor is closed"));
      }
      return closing;
    },
  };
}

/** The caller can leave; the executor retains ownership of the losing work. */
export async function waitForToolWork<T>(
  work: Promise<T>,
  signal: AbortSignal,
  revoke: () => void,
): Promise<T> {
  let onAbort: (() => void) | undefined;
  try {
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => {
        revoke();
        reject(signal.reason);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    return await Promise.race([work, cancelled]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
