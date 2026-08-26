export type ActionableErrorKind =
  | "auth"
  | "forbidden"
  | "not-found"
  | "rate-limited"
  | "server"
  | "timeout"
  | "network"
  | "error"
  | "unknown";

/** Classify raw provider/runtime failures into a stable, actionable category. */
export function classifyActionableError(
  raw: string | undefined,
): ActionableErrorKind {
  if (!raw) return "unknown";
  const lower = raw.toLowerCase();
  if (
    /\b401\b|unauthoriz|authentication.+fail|invalid.+key|invalid.*api.?key|api.?key.+(?:missing|not configured)/.test(
      lower,
    )
  ) {
    return "auth";
  }
  if (/\b403\b|forbidden|permission denied/.test(lower)) return "forbidden";
  if (/\b404\b|not found|unknown model/.test(lower)) return "not-found";
  if (/\b429\b|rate[-\s]?limit|too many/.test(lower)) return "rate-limited";
  if (/\b5\d\d\b|server error|bad gateway|unavailable/.test(lower))
    return "server";
  if (/timeout|timed out|etimedout/.test(lower)) return "timeout";
  if (
    /network|fetch|econnrefused|enotfound|socket|dns|offline|cors|proxy/.test(
      lower,
    )
  ) {
    return "network";
  }
  return "error";
}
