import type { ProviderConfig, UsageSummary } from "../types.js";
import {
  buildStreamEntry,
  getReplayMode,
  hashRequest,
  loadCached,
  recordJsonResponse,
  responseFromCache,
  saveCached,
  teeStreamResponse,
  type ReplayMode,
} from "./replay-cache.js";

/** Maximum characters to include in error message previews. */
const ERROR_PREVIEW_MAX_CHARS = 200;

// ── SSRF Protection ─────────────────────────────────────────────────

/** Known LLM provider domains (and subdomains). */
const KNOWN_PROVIDER_DOMAINS = [
  'api.openai.com',
  'openai.com',
  'anthropic.com',
  'api.anthropic.com',
  'api.deepseek.com',
  'deepseek.com',
  'dashscope.aliyuncs.com',
  'openrouter.ai',
  'api.groq.com',
  'generativelanguage.googleapis.com',
  'api.mistral.ai',
  'api.together.xyz',
  'api.fireworks.ai',
  'api.cohere.com',
];

/** RFC1918, link-local, and cloud metadata IP patterns. */
const BLOCKED_IP_PATTERNS = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^127\./,
  /^0\./,
  /^fc00:/i,
  /^fe80:/i,
  /^::1$/,
];

const BLOCKED_HOSTNAMES = [
  'metadata.google.internal',
  'metadata.internal',
];

function getCustomAllowedHosts(): string[] {
  const raw = process.env.COVEL_ALLOWED_LLM_HOSTS;
  if (!raw) return [];
  return raw.split(',').map((h) => h.trim()).filter(Boolean);
}

function isDomainAllowed(hostname: string): boolean {
  // localhost is always allowed (dev)
  if (hostname === 'localhost' || hostname === '127.0.0.1') return true;

  // Check blocked hostnames
  if (BLOCKED_HOSTNAMES.includes(hostname)) return false;

  // Check blocked IP ranges
  for (const pattern of BLOCKED_IP_PATTERNS) {
    if (pattern.test(hostname)) return false;
  }

  // Check known providers (exact or subdomain match)
  for (const domain of KNOWN_PROVIDER_DOMAINS) {
    if (hostname === domain || hostname.endsWith(`.${domain}`)) return true;
  }

  // Check custom allowed hosts from env
  for (const host of getCustomAllowedHosts()) {
    if (hostname === host || hostname.endsWith(`.${host}`)) return true;
  }

  return false;
}

/**
 * Validate a base URL against SSRF protections.
 * Returns true if the URL is safe to use for server-side requests.
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

  // http only for localhost
  if (parsed.protocol === 'http:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
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
    throw new Error(`Provider error: baseUrl "${config.baseUrl}" is not allowed. Add it to COVEL_ALLOWED_LLM_HOSTS if this is a legitimate provider.`);
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

  // Replay cache: dev-only request record/replay. No-op when env unset.
  const replayMode = getReplayMode();
  const replayHash = replayMode !== "off" ? hashRequest("POST", url, body) : null;
  if (replayHash && (replayMode === "replay" || replayMode === "auto")) {
    const cached = loadCached(replayHash);
    if (cached) {
      return responseFromCache(cached);
    }
    if (replayMode === "replay") {
      throw new Error(
        `[replay-cache] No cached entry for ${replayHash} at ${url} (mode=replay)`
      );
    }
  }

  const doFetch = (): Promise<Response> =>
    fetch(url, {
      method: "POST",
      headers,
      body: serializedBody,
      signal: effectiveSignal,
    });

  // Fast path: retry disabled via escape hatch. Exactly one fetch, no retry logic.
  if (isRetryDisabled()) {
    const response = await doFetch();
    return maybeRecordResponse(response, replayMode, replayHash, "POST", url, body);
  }

  let response = await doFetch();

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (!isRetriableStatus(response.status)) {
      return maybeRecordResponse(response, replayMode, replayHash, "POST", url, body);
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
  return maybeRecordResponse(response, replayMode, replayHash, "POST", url, body);
}

/**
 * Persist the response into the replay cache when in record/auto mode.
 * Streaming responses are tee'd; JSON responses are cloned and read.
 * Errors and non-2xx responses are NOT cached.
 */
async function maybeRecordResponse(
  response: Response,
  mode: ReplayMode,
  hash: string | null,
  method: string,
  url: string,
  body: unknown
): Promise<Response> {
  if (!hash || mode === "off" || mode === "replay") return response;
  if (!response.ok) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    return teeStreamResponse(response, (sseText, headers, status, statusText) => {
      if (sseText === null) return;
      saveCached(
        hash,
        buildStreamEntry(hash, method, url, body, sseText, headers, status, statusText)
      );
    });
  }
  return recordJsonResponse(hash, method, url, body, response);
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

/**
 * Build full URL from base + path.
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
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const p = path.startsWith("/") ? path.slice(1) : path;
  return `${base}/${p}`;
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
