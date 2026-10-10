/** Small, bounded retry policy for transient memory-provider failures. */

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_INITIAL_DELAY_MS = 100;

const TRANSIENT_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_PRX_CONN",
  "UND_ERR_SOCKET",
  "UND_ERR_SOCKS5_REPLY_3",
  "UND_ERR_SOCKS5_REPLY_4",
  "UND_ERR_SOCKS5_REPLY_5",
  "UND_ERR_SOCKS5_REPLY_6",
]);

export async function retryTransientProviderCall(run, options = {}) {
  const maxAttempts = Math.max(
    1,
    Math.floor(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS),
  );
  const initialDelayMs = Math.max(
    0,
    Math.floor(options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS),
  );

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= maxAttempts || !isTransientProviderError(error)) {
        throw error;
      }
      options.onRetry?.(error, attempt + 1);
      const delayMs = initialDelayMs * 2 ** (attempt - 1);
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
}

export function isTransientProviderError(error) {
  const chain = errorChain(error);
  // The caller gave up or the deadline passed: retrying would only outlive it.
  if (chain.some(isAbortError)) return false;
  for (const item of chain) {
    const record = item;
    // AiProviderError exposes the provider adapter's own classification. Honor
    // an explicit value before falling back to generic status/code heuristics.
    if (typeof record.retriable === "boolean") return record.retriable;
    const status = numberValue(record.status) ?? numberValue(record.statusCode);
    if (
      status !== undefined &&
      (status === 408 || status === 425 || status === 429 || status >= 500)
    ) {
      return true;
    }
    const code = typeof record.code === "string" ? record.code : undefined;
    if (code && TRANSIENT_CODES.has(code.toUpperCase())) return true;
  }

  const message = chain
    .map((item) => (item instanceof Error ? item.message : String(item)))
    .join(" ")
    .toLowerCase();
  if (
    /(?:timeout|timed out|socket|connection reset|connection refused|temporarily unavailable|service unavailable|rate.?limit|network error|fetch failed|provider_error)/u.test(
      message,
    )
  ) {
    return true;
  }
  const statusMatch = message.match(/\bhttp\s+(\d{3})\b/u);
  return statusMatch ? Number(statusMatch[1]) >= 500 : false;
}

function isAbortError(item) {
  if (item === null || typeof item !== "object") return false;
  return (
    item.name === "AbortError" ||
    item.name === "TimeoutError" ||
    item.code === "ABORT_ERR"
  );
}

function errorChain(error) {
  const chain = [];
  const seen = new Set();
  let current = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    current =
      typeof current === "object" && "cause" in current
        ? current.cause
        : undefined;
  }
  return chain;
}

function numberValue(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
