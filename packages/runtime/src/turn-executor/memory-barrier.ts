interface MemoryBarrier {
  awaitPending?(sessionId: string): Promise<void>;
}

/** Cancel this execution's wait, never the prior committed turn's memory work. */
export async function awaitPendingMemory(
  updater: MemoryBarrier | undefined,
  sessionId: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (!updater?.awaitPending) return;
  if (!signal) return updater.awaitPending(sessionId);

  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return updater.awaitPending!(sessionId);
      }),
      aborted,
    ]);
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
