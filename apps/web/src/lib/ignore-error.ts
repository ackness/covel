/**
 * Best-effort error swallowing for fire-and-forget promises.
 *
 * Many side effects (persistence flushes, telemetry, background refreshes) are
 * intentionally non-fatal — a failure should not break the UI flow. But fully
 * silent `.catch(() => {})` hides real problems during development. This helper
 * keeps the promise rejection non-fatal while surfacing a `console.warn` in dev
 * builds so failures are visible while debugging. In production it stays quiet.
 *
 * Usage:
 *   doThing().catch(ignoreError("save execution steps"));
 */
export function ignoreError(context: string): (error: unknown) => void {
  return (error: unknown) => {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console -- dev-only diagnostic
      console.warn(`[covel] ignored error (${context}):`, error);
    }
  };
}
