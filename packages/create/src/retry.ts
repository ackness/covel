/**
 * Abort-signal composition for retryable LLM attempts.
 *
 * Extracted from create-world.ts: combines a caller-supplied AbortSignal with
 * a per-attempt timeout so either source can abort the in-flight request.
 */

export function combineAbortSignals(
  primary: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!primary) return timeout;
  if (primary.aborted) return primary;
  const controller = new AbortController();
  const abort = (signal: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  primary.addEventListener("abort", () => abort(primary), { once: true });
  timeout.addEventListener("abort", () => abort(timeout), { once: true });
  return controller.signal;
}
