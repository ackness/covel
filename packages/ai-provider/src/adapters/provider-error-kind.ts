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

/**
 * A provider reports an empty account under several statuses: OpenAI as 429
 * `insufficient_quota`, DeepSeek as 402, Anthropic as 400 with a message.
 * The status and the provider's error code are read first. This text is the
 * fallback for an endpoint that says it only in its message, as Anthropic's
 * 400 `invalid_request_error` does. A 429 is not read by its text: OpenAI's
 * rate-limit message links the billing page too.
 */
const QUOTA_MESSAGE_FALLBACK =
  /insufficient[_ ]quota|insufficient[_ ]balance|credit balance|billing|payment required|exceeded your current quota/i;

/**
 * The failure of the provider account an HTTP error answer names: no
 * balance (`quota`) or a key the provider does not accept (`auth`).
 * `details` holds the `providerCode`, `providerType` and `message` read from
 * the error body. Sending the same request to that provider again fails the
 * same way, so neither the HTTP layer nor the runtime sends it again.
 */
export function accountFailureKind(
  statusCode: number | undefined,
  details: Readonly<Record<string, unknown>> | undefined,
): "quota" | "auth" | undefined {
  if (statusCode === undefined) return undefined;
  if (statusCode === 402) return "quota";
  if (
    providerErrorKind(details?.providerCode, details?.providerType) === "quota"
  )
    return "quota";
  if (
    statusCode !== 429 &&
    statusCode >= 400 &&
    typeof details?.message === "string" &&
    QUOTA_MESSAGE_FALLBACK.test(details.message)
  )
    return "quota";
  if (statusCode === 401 || statusCode === 403) return "auth";
  return undefined;
}
