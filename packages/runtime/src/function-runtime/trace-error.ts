/**
 * Provider / network error messages can echo back request content — a prompt
 * fragment, a URL carrying a token, a model's refusal text. Trace events keep
 * host / usage / duration PII-clean already; this caps the one remaining soft
 * spot by emitting only a bounded, single-line summary of the error.
 */

const MAX_ERROR_CHARS = 256;

export function summarizeTraceError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const oneLine = raw.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_ERROR_CHARS
    ? `${oneLine.slice(0, MAX_ERROR_CHARS)}...`
    : oneLine;
}
