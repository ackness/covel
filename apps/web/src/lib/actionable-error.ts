export type ActionableErrorKind =
  | "auth"
  | "forbidden"
  | "not-found"
  | "rate-limited"
  | "server"
  | "timeout"
  | "network"
  | "invalid-output"
  | "incomplete"
  | "error"
  | "unknown";

/** Classify raw provider/runtime failures into a stable, actionable category. */
export function classifyActionableError(
  raw: string | undefined,
  providerFailureKind?: string,
): ActionableErrorKind {
  const kind = classifyRawActionableError(raw);
  if (providerFailureKind === "missing_key") return "auth";
  if (providerFailureKind === "auth")
    return kind === "forbidden" ? kind : "auth";
  if (providerFailureKind === "quota" || providerFailureKind === "rate_limited")
    return "rate-limited";
  if (providerFailureKind === "not_found") return "not-found";
  return kind;
}

function classifyRawActionableError(
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
  if (
    /output did not match output\.schema|expected a json envelope|schema[- ]validation|exhausted the tool loop|without producing final output|requiretooluse/.test(
      lower,
    )
  ) {
    return "invalid-output";
  }
  return "error";
}
