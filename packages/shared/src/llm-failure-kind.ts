/**
 * What went wrong with a model call, in the terms a player can act on. A
 * model endpoint fails in more ways than a URL does: the key, the balance,
 * the model name and the provider's load each need a different remedy.
 * `classifyProviderFailure` in `@covel/ai-provider` reads an error into one
 * of these.
 *
 * - `unreachable`: no connection (service not running, wrong host or port,
 *   DNS, TLS)
 * - `timeout`: connected, no answer in time
 * - `missing_key`: a known remote provider has no configured key
 * - `auth`: the key is wrong or not allowed to use this model
 * - `quota`: the account has no balance or quota left
 * - `rate_limited`: too many requests for now
 * - `not_found`: the endpoint path or the model ID does not exist
 * - `bad_request`: the provider rejected the request itself
 * - `overloaded`: the provider is over capacity for now
 * - `server`: another fault on the provider's side
 * - `refused`: the provider withheld the answer
 * - `config`: the model configuration cannot make this call
 */
export type ProviderFailureKind =
  | "unreachable"
  | "timeout"
  | "missing_key"
  | "auth"
  | "quota"
  | "rate_limited"
  | "not_found"
  | "bad_request"
  | "overloaded"
  | "server"
  | "refused"
  | "config"
  | "unknown";

/**
 * A failure of the account at this provider: no key, no balance, or a key it does
 * not accept. Sending the same request to the same provider again fails the
 * same way until the player fixes the account, so it is never retried there.
 * A backup the player configured is another target and may still work; the
 * gateway skips a same-account backup after a missing key, 401, or balance failure.
 */
export function isAccountFailure(kind: ProviderFailureKind): boolean {
  return kind === "quota" || kind === "auth" || kind === "missing_key";
}
