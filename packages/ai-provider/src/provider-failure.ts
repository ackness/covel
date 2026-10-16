import type { ProviderFailureKind } from "@covel/shared";
import { accountFailureKind } from "./adapters/provider-error-kind.js";
import { ProviderBaseUrlError } from "./errors.js";
import { normalizeError } from "./gateway-lifecycle.js";

export type { ProviderFailureKind };

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

  if (normalized.code === "MISSING_API_KEY") return failure("missing_key");
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

  const account = accountFailureKind(statusCode, details);
  if (account) return failure(account);
  if (statusCode === 404) return failure("not_found");
  if (statusCode === 408 || statusCode === 504) return failure("timeout");
  if (statusCode === 429) return failure("rate_limited");
  if (statusCode === 503 || statusCode === 529) return failure("overloaded");
  if (statusCode >= 500) return failure("server");
  if (statusCode >= 400) return failure("bad_request");
  return failure("unknown");
}
