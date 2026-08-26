import type { FormData as UndiciFormData } from "undici";
import { ERROR_PREVIEW_MAX_CHARS } from "./constants.js";

export async function parseJson(
  response: Response,
): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) {
    throw new Error(
      `Provider returned empty response (HTTP ${response.status} ${response.statusText})`,
    );
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(
      `Provider returned non-JSON response (HTTP ${response.status}): ${text.slice(0, ERROR_PREVIEW_MAX_CHARS)}`,
    );
  }
}

export async function* iterateSsePayloads(
  response: Response,
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
            `Provider returned malformed SSE payload: ${data.slice(0, ERROR_PREVIEW_MAX_CHARS)}`,
          );
        }
        yield parsed;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function assertSuccess(
  response: Response,
  payload: Record<string, unknown>,
  provider: string,
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
        : (errorObj ?? undefined),
    }),
  );
}

export function createStructuredOutputError(provider: string): Error {
  return new Error(
    JSON.stringify({
      name: "AiProviderError",
      code: "SCHEMA_VALIDATION_FAILED",
      provider,
      retriable: false,
    }),
  );
}

export function createUnsupportedModeError(
  provider: string,
  mode: string,
): Error {
  return new Error(
    JSON.stringify({
      name: "AiProviderError",
      code: "PROVIDER_ERROR",
      provider,
      retriable: false,
      details: { mode },
    }),
  );
}

export function appendProviderMetadata(
  formData: UndiciFormData,
  metadata: Record<string, unknown> | undefined,
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
