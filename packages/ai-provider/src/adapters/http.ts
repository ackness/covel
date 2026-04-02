import type { ProviderConfig, UsageSummary } from "../types.js";

/** Maximum characters to include in error message previews. */
const ERROR_PREVIEW_MAX_CHARS = 200;

/**
 * POST JSON body to a provider endpoint.
 */
export async function postJson(
  config: ProviderConfig,
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal
): Promise<Response> {
  if (!config.baseUrl) {
    throw new Error("Provider error: baseUrl is required.");
  }

  return fetch(buildProviderUrl(config.baseUrl, path), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      ...config.headers,
    },
    body: JSON.stringify(body),
    signal: signal ?? config.signal,
  });
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

/** Safely cast an unknown value to a record for optional chaining. */
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

export function toAnthropicMessages(
  messages: Array<{ role: string; content: string | null }>
): { system: string; messages: Array<{ role: string; content: string }> } {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content ?? "")
    .filter(Boolean)
    .join("\n\n");
  const filtered = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: m.content ?? "" }));
  return { system, messages: filtered };
}
