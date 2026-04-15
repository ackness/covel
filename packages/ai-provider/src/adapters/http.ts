import type { ProviderConfig, UsageSummary } from "../types.js";

/** Maximum characters to include in error message previews. */
const ERROR_PREVIEW_MAX_CHARS = 200;

// ── SSRF Protection ─────────────────────────────────────────────────

/** Loopback hostnames always allowed for local development (Ollama etc.). */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

/** RFC1918 and link-local IP ranges — always blocked (internal network SSRF). */
const BLOCKED_IP_PATTERNS = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^fc00:/i,
  /^fe80:/i,
];

/** Cloud metadata service hostnames — blocked regardless of IP. */
const BLOCKED_HOSTNAMES = [
  'metadata.google.internal',
  'metadata.internal',
];

/**
 * Check whether a hostname is safe to connect to.
 *
 * Policy (open by default, block only dangerous internals):
 * - Loopback (localhost, 127.0.0.1, ::1) → always allowed (local dev)
 * - Cloud metadata hostnames → always blocked
 * - RFC1918 / link-local IP ranges → blocked
 * - All other public hostnames → allowed (users bring their own providers)
 */
function isDomainAllowed(hostname: string): boolean {
  // Always allow loopback for local development
  if (LOOPBACK_HOSTNAMES.has(hostname)) return true;

  // Block known cloud metadata hostnames
  if (BLOCKED_HOSTNAMES.includes(hostname)) return false;

  // Block RFC1918 and link-local IP ranges
  for (const pattern of BLOCKED_IP_PATTERNS) {
    if (pattern.test(hostname)) return false;
  }

  // Allow all other hosts (public providers, self-hosted, custom endpoints)
  return true;
}

/**
 * Validate a base URL against SSRF protections.
 * Returns true if the URL is safe to use for server-side requests.
 *
 * Allowed: https for any public domain; http for localhost only.
 * Blocked: private IP ranges, cloud metadata endpoints, non-http(s) protocols.
 */
export function validateBaseUrl(url: string): boolean {
  if (!url) return false;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  // Only http/https allowed
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  // http (non-TLS) only allowed for loopback — all remote endpoints must use https
  if (parsed.protocol === 'http:' && !LOOPBACK_HOSTNAMES.has(parsed.hostname)) {
    return false;
  }

  return isDomainAllowed(parsed.hostname);
}

// ── Retry policy (S1-T3) ─────────────────────────────────────────

/** Maximum number of retries after the initial attempt (so total attempts = 1 + MAX_RETRIES). */
const MAX_RETRIES = 3;
/** Base backoff in milliseconds; actual delay = BASE_BACKOFF_MS * 2^attempt * jitter. */
const BASE_BACKOFF_MS = 500;
/** Cap on backoff delay. */
const MAX_BACKOFF_MS = 8000;
/** Jitter factor range for randomized backoff. */
const JITTER_MIN = 0.75;
const JITTER_MAX = 1.25;

/**
 * Whether a given HTTP status code should trigger a retry.
 * Retries on 429 (rate limit) and 5xx (transient server errors).
 * Non-retriable on other 4xx (400/401/403/404 etc) and 2xx/3xx.
 */
export function isRetriableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Compute exponential-backoff delay in milliseconds with jitter.
 * @param attempt 0-based retry index (0 = first retry, 1 = second, ...).
 */
export function computeBackoffMs(attempt: number): number {
  const exp = BASE_BACKOFF_MS * Math.pow(2, attempt);
  const jitter = JITTER_MIN + Math.random() * (JITTER_MAX - JITTER_MIN);
  return Math.min(MAX_BACKOFF_MS, Math.floor(exp * jitter));
}

/**
 * Parse a `Retry-After` header value (integer seconds) into milliseconds.
 * Returns `null` when the header is absent or not a non-negative integer.
 * NOTE: HTTP-date form is intentionally not supported — LLM providers only
 * emit the delta-seconds form in practice.
 */
export function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number(trimmed) * 1000;
}

/**
 * Sleep for `ms` milliseconds, aborting early if `signal` fires.
 * Rejects with the signal's abort reason (DOMException AbortError by default).
 */
export function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Check whether retry is disabled via the `COVEL_LLM_RETRY_DISABLED` env var.
 * Read lazily on each call so tests can flip the flag per-case.
 */
function isRetryDisabled(): boolean {
  return process.env.COVEL_LLM_RETRY_DISABLED === "1";
}

/**
 * POST JSON body to a provider endpoint.
 *
 * Robustness (S1-T3): applies exponential-backoff retry on HTTP 429 and 5xx
 * responses. Honors the `Retry-After` header when present. Does NOT retry on
 * `fetch()` throws (network errors, DNS failures, connection refused) —
 * those are a different failure class and stay with the caller. If all
 * retries are exhausted the last failed `Response` is returned, letting the
 * caller's existing `assertSuccess` error-classification path fire.
 *
 * Retry can be disabled entirely via `COVEL_LLM_RETRY_DISABLED=1`.
 */
export async function postJson(
  config: ProviderConfig,
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  overrideHeaders?: Record<string, string>,
): Promise<Response> {
  if (!config.baseUrl) {
    throw new Error("Provider error: baseUrl is required.");
  }
  if (!validateBaseUrl(config.baseUrl)) {
    throw new Error(`Provider error: baseUrl "${config.baseUrl}" is not allowed. Only public HTTPS endpoints are permitted (private/internal IPs are blocked).`);
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    ...config.headers,
    ...overrideHeaders,
  };

  const url = buildProviderUrl(config.baseUrl, path);
  const serializedBody = JSON.stringify(body);
  const effectiveSignal = signal ?? config.signal;

  const doFetch = (): Promise<Response> =>
    fetch(url, {
      method: "POST",
      headers,
      body: serializedBody,
      signal: effectiveSignal,
    });

  // Fast path: retry disabled via escape hatch. Exactly one fetch, no retry logic.
  if (isRetryDisabled()) {
    return doFetch();
  }

  let response = await doFetch();

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (!isRetriableStatus(response.status)) {
      return response;
    }

    // Drain the failed body to free the socket before retrying.
    // `.arrayBuffer()` is used because the body is cheap JSON in practice.
    await response.arrayBuffer().catch(() => { /* body already consumed or stream error */ });

    const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
    const delay = retryAfterMs ?? computeBackoffMs(attempt);

    // If the signal aborts during the wait, sleepWithAbort rejects and we
    // let the rejection bubble up — the caller sees an AbortError, same as
    // they would from any interrupted fetch.
    await sleepWithAbort(delay, effectiveSignal);

    response = await doFetch();
  }

  // Retries exhausted — return whatever we have and let assertSuccess classify it.
  return response;
}

/**
 * POST FormData (multipart) to a provider endpoint.
 */
export async function postFormData(
  config: ProviderConfig,
  path: string,
  body: FormData,
  signal?: AbortSignal
): Promise<Response> {
  if (!config.baseUrl) {
    throw new Error("Provider error: baseUrl is required.");
  }

  return fetch(buildProviderUrl(config.baseUrl, path), {
    method: "POST",
    headers: {
      ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      ...config.headers,
    },
    body,
    signal: signal ?? config.signal,
  });
}

/** Regex for a trailing API version segment like `/v1`, `/v2`, `/v1beta`. */
const TRAILING_VERSION_RE = /\/(v\d+[a-z0-9]*)$/i;

/**
 * Build full URL from base + path with tolerant version handling.
 *
 * All OpenAI-compatible / Anthropic endpoints live under `/v1/*`. Users
 * commonly write their baseUrl either with the `/v1` suffix already
 * baked in (`https://api.deepseek.com/v1`) or without (`https://api.deepseek.com`).
 * Before this normalisation, omitting `/v1` silently produced a broken
 * URL like `https://api.deepseek.com/chat/completions`.
 *
 * Rules:
 *
 *   1. If baseUrl already ends with `/vN` (`v1`, `v2`, `v1beta`, ...),
 *      trust the user's explicit version and don't touch it.
 *   2. Otherwise, inject `/v1` as the default version segment. This
 *      matches the OpenAI-compat convention used by every adapter in
 *      this repo (openai-chat, openai-responses, anthropic-messages).
 *   3. If the *path* also starts with the same version segment, dedupe
 *      so we never emit `/v1/v1/...` even when both sides include it.
 *
 * Examples (all four yield `https://host/v1/chat/completions`):
 *
 *   buildProviderUrl("https://host",          "/chat/completions")
 *   buildProviderUrl("https://host/v1",       "/chat/completions")
 *   buildProviderUrl("https://host",          "/v1/chat/completions")
 *   buildProviderUrl("https://host/v1",       "/v1/chat/completions")
 */
export function buildProviderUrl(baseUrl: string, path: string): string {
  if (
    baseUrl &&
    !baseUrl.startsWith("https://") &&
    !baseUrl.startsWith("http://localhost") &&
    !baseUrl.startsWith("http://127.0.0.1")
  ) {
    console.warn(
      `[ai-provider] Non-HTTPS base URL detected: ${baseUrl}. API keys may be sent in plaintext.`,
    );
  }

  // Strip trailing slash(es) on baseUrl, normalise leading slash on path.
  let base = baseUrl.replace(/\/+$/, "");
  let p = path.startsWith("/") ? path : `/${path}`;

  // Rule 1: Does baseUrl already carry an explicit version segment?
  const baseVersionMatch = base.match(TRAILING_VERSION_RE);
  const effectiveVersion = baseVersionMatch?.[1] ?? "v1";

  // Rule 2: If missing, append the default version so we always end up
  // hitting /v1/<endpoint> (or whichever version the user pinned).
  if (!baseVersionMatch) {
    base = `${base}/${effectiveVersion}`;
  }

  // Rule 3: If the path leads with the same version, dedupe.
  const pathVersionPrefix = `/${effectiveVersion}/`;
  if (p === `/${effectiveVersion}` || p.startsWith(pathVersionPrefix)) {
    p = p.slice(effectiveVersion.length + 1) || "/";
  }

  return `${base}${p}`;
}

/**
 * Parse JSON response body.
 * Falls back to text parsing when `.json()` fails (e.g. empty body on 404).
 */
export async function parseJson(
  response: Response
): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) {
    throw new Error(
      `Provider returned empty response (HTTP ${response.status} ${response.statusText})`
    );
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(
      `Provider returned non-JSON response (HTTP ${response.status}): ${text.slice(0, ERROR_PREVIEW_MAX_CHARS)}`
    );
  }
}

/**
 * Iterate SSE payloads from a streaming response.
 * Yields parsed JSON objects from `data:` lines.
 */
export async function* iterateSsePayloads(
  response: Response
): AsyncIterable<Record<string, unknown>> {
  if (!response.body) return;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      while (buffer.includes("\n\n")) {
        const boundary = buffer.indexOf("\n\n");
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const dataLine = frame
          .split("\n")
          .find((line) => line.startsWith("data: "));
        if (!dataLine) continue;

        const data = dataLine.slice(6).trim();
        if (data === "[DONE]") continue;

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(data) as Record<string, unknown>;
        } catch {
          throw new Error(
            `Provider returned malformed SSE payload: ${data.slice(0, ERROR_PREVIEW_MAX_CHARS)}`
          );
        }
        yield parsed;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Assert HTTP response success, throw typed error on failure.
 */
export function assertSuccess(
  response: Response,
  payload: Record<string, unknown>,
  provider: string
): void {
  if (response.ok) return;

  const errorObj = payload.error as Record<string, unknown> | undefined;
  const errorType = errorObj?.type;
  const errorMessage =
    typeof errorObj?.message === "string"
      ? errorObj.message
      : typeof payload.message === "string"
        ? payload.message
        : undefined;
  const isRateLimit =
    response.status === 429 || errorType === "rate_limit_error";

  throw new Error(
    JSON.stringify({
      name: "AiProviderError",
      code: isRateLimit ? "RATE_LIMITED" : "PROVIDER_ERROR",
      provider,
      retriable: isRateLimit || response.status >= 500,
      statusCode: response.status,
      details: errorMessage
        ? { message: errorMessage, type: errorType }
        : errorObj ?? undefined,
    })
  );
}

/**
 * Create a schema validation error.
 */
export function createStructuredOutputError(provider: string): Error {
  return new Error(
    JSON.stringify({
      name: "AiProviderError",
      code: "SCHEMA_VALIDATION_FAILED",
      provider,
      retriable: false,
    })
  );
}

/**
 * Create an unsupported mode error.
 */
export function createUnsupportedModeError(
  provider: string,
  mode: string
): Error {
  return new Error(
    JSON.stringify({
      name: "AiProviderError",
      code: "PROVIDER_ERROR",
      provider,
      retriable: false,
      details: { mode },
    })
  );
}

/**
 * Append flat metadata to FormData.
 */
export function appendProviderMetadata(
  formData: FormData,
  metadata: Record<string, unknown> | undefined
): void {
  if (!metadata) return;
  for (const [key, value] of Object.entries(metadata)) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      formData.set(key, String(value));
    }
  }
}

// ── Internal helper ──────────────────────────────────────────────

/**
 * Safely cast an unknown value to a record for optional chaining.
 *
 * TODO: Replace with properly typed helper functions per provider response shape.
 * Each call site (readOpenAiChatText, readOpenAiChatStreamDelta, etc.) should
 * use narrowing or typed response interfaces instead of bypassing the type system.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function asAny(value: unknown): any {
  return value;
}

// ── OpenAI Chat helpers ──────────────────────────────────────────

export function readOpenAiChatText(payload: Record<string, unknown>): string {
  return String(asAny(payload).choices?.[0]?.message?.content ?? "");
}

export function readOpenAiChatFinishReason(
  payload: Record<string, unknown>
): string {
  return String(asAny(payload).choices?.[0]?.finish_reason ?? "stop");
}

export function readOpenAiChatUsage(
  payload: Record<string, unknown>
): UsageSummary {
  const usage = payload.usage as Record<string, unknown> | undefined;
  return {
    inputTokens: Number(usage?.prompt_tokens ?? 0),
    outputTokens: Number(usage?.completion_tokens ?? 0),
  };
}

export function readOpenAiChatStreamDelta(
  payload: Record<string, unknown>
): string | null {
  const delta = asAny(payload).choices?.[0]?.delta?.content;
  return typeof delta === "string" ? delta : null;
}

export function readOpenAiChatStreamReasoningDelta(
  payload: Record<string, unknown>
): string | null {
  const delta = asAny(payload).choices?.[0]?.delta?.reasoning_content;
  return typeof delta === "string" && delta.length > 0 ? delta : null;
}

export function readOpenAiChatStreamFinishReason(
  payload: Record<string, unknown>
): string | null {
  const reason = asAny(payload).choices?.[0]?.finish_reason;
  return typeof reason === "string" ? reason : null;
}

/**
 * Read tool_calls deltas from a streaming chunk.
 * OpenAI streams tool_calls as partial JSON arguments keyed by index:
 *   delta.tool_calls = [{ index: 0, id?, type?, function: { name?, arguments? } }]
 * Caller is responsible for accumulating by index across chunks.
 */
export function readOpenAiChatStreamToolCallDeltas(
  payload: Record<string, unknown>
): Array<{
  index: number;
  id?: string;
  name?: string;
  argumentsDelta?: string;
}> | null {
  const toolCalls = asAny(payload).choices?.[0]?.delta?.tool_calls;
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return null;
  return toolCalls.map((tc: Record<string, unknown>) => {
    const fn = tc.function as Record<string, unknown> | undefined;
    return {
      index: Number(tc.index ?? 0),
      id: typeof tc.id === "string" ? tc.id : undefined,
      name: typeof fn?.name === "string" ? fn.name : undefined,
      argumentsDelta: typeof fn?.arguments === "string" ? fn.arguments : undefined,
    };
  });
}

/**
 * Read tool_calls from an OpenAI chat completion response.
 */
export function readOpenAiChatToolCalls(
  payload: Record<string, unknown>
): Array<{ id: string; name: string; arguments: string }> | null {
  const toolCalls = asAny(payload).choices?.[0]?.message?.tool_calls;
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return null;
  const valid = toolCalls.filter(
    (tc: unknown): tc is { id: string; function: { name: string; arguments: string } } => {
      const entry = tc as Record<string, unknown> | null | undefined;
      return (
        typeof entry?.id === "string" &&
        typeof (entry?.function as Record<string, unknown> | undefined)?.name === "string" &&
        typeof (entry?.function as Record<string, unknown> | undefined)?.arguments === "string"
      );
    }
  );
  if (valid.length === 0) return null;
  return valid.map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    arguments: tc.function.arguments,
  }));
}

// ── OpenAI Responses helpers ─────────────────────────────────────

export function readResponsesOutputText(
  payload: Record<string, unknown>
): string {
  if (typeof payload.output_text === "string") return payload.output_text;
  return String(asAny(payload).output?.[0]?.content?.[0]?.text ?? "");
}

// ── Anthropic helpers ────────────────────────────────────────────

export function readAnthropicText(payload: Record<string, unknown>): string {
  const block = Array.isArray(payload.content)
    ? payload.content.find(
        (entry: Record<string, unknown>) => entry.type === "text"
      )
    : null;
  return String(block?.text ?? "");
}

let _toolDropWarned = false;

export function toAnthropicMessages(
  messages: Array<{ role: string; content: string | null }>
): { system: string; messages: Array<{ role: string; content: string }> } {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content ?? "")
    .filter(Boolean)
    .join("\n\n");
  const toolMessages = messages.filter((m) => m.role === "tool");
  if (toolMessages.length > 0 && !_toolDropWarned) {
    _toolDropWarned = true;
    console.warn(
      `[anthropic] Dropped ${toolMessages.length} tool-role message(s) (not supported in this adapter path). This warning is shown once.`,
    );
  }
  const filtered = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: m.content ?? "" }));
  return { system, messages: filtered };
}
