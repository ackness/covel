/**
 * What a provider's own error code says, in the few classes the gateway acts
 * on. A code outside them (a rate limit, a server fault, an unknown word)
 * has no kind, and the HTTP status decides.
 */
export type ProviderErrorKind =
  "refusal" | "quota" | "auth" | "not_found" | "invalid_request";

/**
 * The `error.code` / `error.type` (OpenAI, Anthropic) and `error.status`
 * (Google) values the three API families document, lower-cased.
 */
const KNOWN_CODES: ReadonlyMap<string, ProviderErrorKind> = new Map([
  ["content_filter", "refusal"],
  ["content_policy_violation", "refusal"],
  ["insufficient_quota", "quota"],
  ["billing_error", "quota"],
  ["billing_hard_limit_reached", "quota"],
  ["billing_not_active", "quota"],
  ["invalid_api_key", "auth"],
  ["authentication_error", "auth"],
  ["permission_error", "auth"],
  ["permission_denied", "auth"],
  ["unauthenticated", "auth"],
  ["not_found_error", "not_found"],
  ["model_not_found", "not_found"],
  ["not_found", "not_found"],
  ["invalid_request_error", "invalid_request"],
  ["invalid_argument", "invalid_request"],
  ["invalid_prompt", "invalid_request"],
  ["context_length_exceeded", "invalid_request"],
  ["request_too_large", "invalid_request"],
]);

/**
 * Compatible gateways vary the documented words (`ContentPolicyViolation`
 * style suffixes, `insufficient_balance`, `token_limit_reached`). These
 * fragments of a code are the fallback after the exact table.
 */
const CODE_FRAGMENTS: ReadonlyArray<readonly [RegExp, ProviderErrorKind]> = [
  [/content_filter|content_policy|safety|refusal/, "refusal"],
  [/insufficient_quota|insufficient_balance|billing/, "quota"],
  [/authentication|permission/, "auth"],
  [/not_found/, "not_found"],
  [/invalid_request|context_length|token_limit/, "invalid_request"],
];

/** Classify by the provider's code first, then by its type. */
export function providerErrorKind(
  ...codes: readonly unknown[]
): ProviderErrorKind | undefined {
  const words = codes
    .filter((code): code is string => typeof code === "string" && code !== "")
    .map((code) => code.toLowerCase());
  for (const word of words) {
    const known = KNOWN_CODES.get(word);
    if (known) return known;
  }
  for (const [fragment, kind] of CODE_FRAGMENTS) {
    if (words.some((word) => fragment.test(word))) return kind;
  }
  return undefined;
}
