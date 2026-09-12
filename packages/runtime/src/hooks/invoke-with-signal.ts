/** Bound a cooperative hook to its parent execution and its own timeout. */
export async function invokeWithSignal<T>(
  invoke: (signal: AbortSignal) => Promise<T>,
  parent: AbortSignal | undefined,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  const controller = new AbortController();
  const onParentAbort = (): void => controller.abort(parent?.reason);
  parent?.addEventListener("abort", onParentAbort, { once: true });
  if (parent?.aborted) onParentAbort();
  const timer = setTimeout(
    () => controller.abort(new Error(timeoutMessage)),
    timeoutMs,
  );
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", onAbort, { once: true });
      if (controller.signal.aborted) {
        onAbort();
        return;
      }
      // Attach rejection handling even when cancellation wins the race. A late
      // handler result cannot replace the already settled pipeline result.
      Promise.resolve()
        .then(() => {
          controller.signal.throwIfAborted();
          return invoke(controller.signal);
        })
        .then(resolve, reject);
    });
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", onParentAbort);
    if (onAbort) controller.signal.removeEventListener("abort", onAbort);
  }
}
