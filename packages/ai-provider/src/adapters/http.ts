import type { ProviderConfig, UsageSummary } from "../types.js";

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
    signal,
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
    signal,
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
 */
export async function parseJson(
  response: Response
): Promise<Record<string, any>> {
  return (await response.json()) as Record<string, any>;
}

/**
 * Iterate SSE payloads from a streaming response.
 * Yields parsed JSON objects from `data:` lines.
 */
export async function* iterateSsePayloads(
  response: Response
): AsyncIterable<Record<string, any>> {
  if (!response.body) return;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

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

      yield JSON.parse(data) as Record<string, any>;
    }
  }
}

/**
 * Assert HTTP response success, throw typed error on failure.
 */
export function assertSuccess(
  response: Response,
  payload: Record<string, any>,
  provider: string
): void {
  if (response.ok) return;

  const errorType = payload.error?.type;
  const isRateLimit =
    response.status === 429 || errorType === "rate_limit_error";

  throw new Error(
    JSON.stringify({
      name: "AiProviderError",
      code: isRateLimit ? "RATE_LIMITED" : "PROVIDER_ERROR",
      provider,
      retriable: isRateLimit || response.status >= 500,
      statusCode: response.status,
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

// ── OpenAI Chat helpers ──────────────────────────────────────────

export function readOpenAiChatText(payload: Record<string, any>): string {
  return String(payload.choices?.[0]?.message?.content ?? "");
}

export function readOpenAiChatFinishReason(
  payload: Record<string, any>
): string {
  return String(payload.choices?.[0]?.finish_reason ?? "stop");
}

export function readOpenAiChatUsage(
  payload: Record<string, any>
): UsageSummary {
  return {
    inputTokens: Number(payload.usage?.prompt_tokens ?? 0),
    outputTokens: Number(payload.usage?.completion_tokens ?? 0),
  };
}

export function readOpenAiChatStreamDelta(
  payload: Record<string, any>
): string | null {
  const delta = payload.choices?.[0]?.delta?.content;
  return typeof delta === "string" ? delta : null;
}

export function readOpenAiChatStreamFinishReason(
  payload: Record<string, any>
): string | null {
  const reason = payload.choices?.[0]?.finish_reason;
  return typeof reason === "string" ? reason : null;
}

// ── OpenAI Responses helpers ─────────────────────────────────────

export function readResponsesOutputText(
  payload: Record<string, any>
): string {
  if (typeof payload.output_text === "string") return payload.output_text;
  return String(payload.output?.[0]?.content?.[0]?.text ?? "");
}

// ── Anthropic helpers ────────────────────────────────────────────

export function readAnthropicText(payload: Record<string, any>): string {
  const block = Array.isArray(payload.content)
    ? payload.content.find(
        (entry: Record<string, unknown>) => entry.type === "text"
      )
    : null;
  return String(block?.text ?? "");
}

export function toAnthropicMessages(
  messages: Array<{ role: string; content: string }>
) {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: m.content }));
}
