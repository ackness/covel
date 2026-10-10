import { providerErrorKind } from "./adapters/provider-error-kind.js";
import { ProviderBaseUrlError } from "./errors.js";
import { normalizeError } from "./gateway-lifecycle.js";

/**
 * What went wrong with a provider call, in the terms a player can act on.
 * A model endpoint fails in more ways than a URL does: the key, the balance,
 * the model name and the provider's load each need a different remedy.
 *
 * - `unreachable`: no connection (service not running, wrong host or port,
 *   DNS, TLS)
 * - `timeout`: connected, no answer in time
 * - `auth`: the key is missing, wrong, or not allowed to use this model
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

export interface ProviderFailure {
  readonly kind: ProviderFailureKind;
  readonly message: string;
  readonly statusCode?: number;
}

const UNREACHABLE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "UND_ERR_SOCKET",
]);
const TIMEOUT_CODES = new Set([
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/**
 * A provider reports an empty account under several statuses: OpenAI as 429
 * `insufficient_quota`, DeepSeek as 402, Anthropic as 400 with a message.
 * The status and the provider's error code are read first. This text is the
 * fallback for an endpoint that says it only in its message, as Anthropic's
 * 400 `invalid_request_error` does.
 */
const QUOTA_MESSAGE_FALLBACK =
  /insufficient[_ ]quota|insufficient[_ ]balance|credit balance|billing|payment required|exceeded your current quota/i;

function isEmptyAccount(
  statusCode: number,
  details: Record<string, unknown> | undefined,
): boolean {
  if (statusCode === 402) return true;
  if (
    providerErrorKind(details?.providerCode, details?.providerType) === "quota"
  )
    return true;
  return (
    typeof details?.message === "string" &&
    QUOTA_MESSAGE_FALLBACK.test(details.message)
  );
}

function hasBaseUrlFault(error: unknown): boolean {
  let current = error;
  for (let depth = 0; current instanceof Error && depth < 8; depth++) {
    if (current instanceof ProviderBaseUrlError) return true;
    current = current.cause;
  }
  return false;
}

const TLS_CODE = /^(CERT_|DEPTH_ZERO_|SELF_SIGNED_|UNABLE_TO_VERIFY|ERR_TLS_)/;

/** Fetch and Undici keep the reason of a failed connection in `cause`. */
function transportCause(
  error: unknown,
): { kind: "unreachable" | "timeout"; message: string } | undefined {
  let current = error;
  for (let depth = 0; current instanceof Error && depth < 8; depth++) {
    const code = (current as Error & { code?: unknown }).code;
    if (typeof code === "string") {
      if (TIMEOUT_CODES.has(code))
        return { kind: "timeout", message: current.message };
      if (UNREACHABLE_CODES.has(code) || TLS_CODE.test(code))
        return { kind: "unreachable", message: current.message };
    }
    current = current.cause;
  }
  return undefined;
}

function isTimeout(error: unknown): boolean {
  let current = error;
  for (let depth = 0; current instanceof Error && depth < 8; depth++) {
    if (current.name === "TimeoutError" || current.name === "AbortError")
      return true;
    current = current.cause;
  }
  return false;
}

export function classifyProviderFailure(
  error: unknown,
  provider = "unknown",
): ProviderFailure {
  const normalized = normalizeError(error, provider);
  const { statusCode, details } = normalized;
  const failure = (
    kind: ProviderFailureKind,
    message = normalized.message,
  ) => ({
    kind,
    message,
    ...(statusCode !== undefined ? { statusCode } : {}),
  });

  if (normalized.code === "REFUSAL") return failure("refused");
  if (normalized.code === "CONFIG_ERROR") return failure("config");
  if (normalized.code === "REQUEST_BUDGET_EXCEEDED") return failure("timeout");

  if (statusCode === undefined) {
    // "fetch failed" says nothing; the cause names the host and port.
    const cause = transportCause(error);
    if (cause) return failure(cause.kind, cause.message || normalized.message);
    if (isTimeout(error)) return failure("timeout");
    if (hasBaseUrlFault(error)) return failure("config");
    return failure(
      normalized.code === "RATE_LIMITED" ? "rate_limited" : "unknown",
    );
  }

  if (isEmptyAccount(statusCode, details)) return failure("quota");
  if (statusCode === 401 || statusCode === 403) return failure("auth");
  if (statusCode === 404) return failure("not_found");
  if (statusCode === 408 || statusCode === 504) return failure("timeout");
  if (statusCode === 429) return failure("rate_limited");
  if (statusCode === 503 || statusCode === 529) return failure("overloaded");
  if (statusCode >= 500) return failure("server");
  if (statusCode >= 400) return failure("bad_request");
  return failure("unknown");
}
