import { isEnvEnabled } from "@covel/shared";

const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8000;
const JITTER_MIN = 0.75;
const JITTER_MAX = 1.25;

export const MAX_RETRIES = 3;

/**
 * The statuses the OpenAI and Anthropic SDKs and the AI SDK send again: a
 * request timeout, a lock conflict, a rate limit and a server fault.
 */
export function isRetriableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/**
 * Whether a response is sent again. `x-should-retry` is the provider's own
 * answer (OpenAI and Anthropic set it) and wins over the status.
 */
export function shouldRetryResponse(response: Response): boolean {
  if (response.ok) return false;
  const instruction = response.headers.get("x-should-retry");
  if (instruction === "true") return true;
  if (instruction === "false") return false;
  return isRetriableStatus(response.status);
}

/**
 * A wait longer than this is not a retry of one call. The response goes back
 * to the caller, which can turn to a backup model.
 */
export const MAX_RETRY_AFTER_MS = 60_000;

/**
 * The wait a response asks for: `retry-after-ms` (OpenAI, Azure) is the more
 * precise of the two headers, then `retry-after` in seconds or as a date.
 */
export function parseRetryDelayMs(
  headers: Headers,
  now = Date.now(),
): number | null {
  const precise = headers.get("retry-after-ms")?.trim();
  if (precise && /^\d+(?:\.\d+)?$/.test(precise))
    return Math.ceil(Number(precise));
  return parseRetryAfterMs(headers.get("retry-after"), now);
}

// What Node and Undici report when the endpoint refused the connection or
// closed it before it answered.
const CONNECTION_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "UND_ERR_SOCKET",
]);

/**
 * Whether a request failed because the connection was refused or dropped
 * before a response arrived. An endpoint that restarts, a local proxy above
 * all, is back a moment later, so such a request is sent again like one that
 * got a 5xx. A timeout is not in this set: the attempt that set it decides.
 */
export function isConnectionError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const code = (current as Error & { code?: unknown }).code;
    if (typeof code === "string" && CONNECTION_ERROR_CODES.has(code))
      return true;
    current = current.cause;
  }
  return false;
}

export function computeBackoffMs(attempt: number): number {
  const exp = BASE_BACKOFF_MS * Math.pow(2, attempt);
  const jitter = JITTER_MIN + Math.random() * (JITTER_MAX - JITTER_MIN);
  return Math.min(MAX_BACKOFF_MS, Math.floor(exp * jitter));
}

export function parseRetryAfterMs(
  header: string | null,
  now = Date.now(),
): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  // Reject malformed numeric delays instead of letting Date.parse interpret
  // values such as "0.5" as calendar dates.
  if (!/[a-z]/i.test(trimmed)) return null;
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

export function sleepWithAbort(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    if (!Number.isFinite(ms) || ms < 0) {
      reject(
        new RangeError("Retry delay must be a finite non-negative number"),
      );
      return;
    }

    let remaining = ms;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      // Node clamps overflowing delays to 1ms. Split long Retry-After waits
      // instead so a large valid value never causes an immediate retry storm.
      const delay = Math.min(remaining, 2_147_483_647);
      timer = setTimeout(() => {
        remaining -= delay;
        if (remaining > 0) schedule();
        else {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }
      }, delay);
    };

    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    schedule();
  });
}

export function isRetryDisabled(): boolean {
  return isEnvEnabled("COVEL_LLM_RETRY_DISABLED");
}
