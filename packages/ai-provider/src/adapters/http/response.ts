import type { FormData as UndiciFormData } from "undici";
import {
  ERROR_PREVIEW_MAX_CHARS,
  MAX_JSON_RESPONSE_BYTES,
} from "./constants.js";
import { AiProviderError } from "../../errors.js";
import type { UsageSummary } from "../../types.js";
import { isRetriableStatus } from "./retry.js";

/**
 * The endpoint sent more than a response may hold. It is a plain error on
 * purpose: the gateway reports it as a provider error that is not retried,
 * because the same request would get the same body again.
 */
export class ProviderResponseTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Provider response exceeds the ${maxBytes}-byte limit.`);
    this.name = "ProviderResponseTooLargeError";
  }
}

/**
 * Read a body chunk by chunk and stop at `maxBytes`: the connection is
 * cancelled as soon as the count passes it, and before the first read when
 * Content-Length already says so.
 */
async function* readBoundedChunks(
  body: ReadableStream<Uint8Array>,
  headers: Headers,
  maxBytes: number,
): AsyncGenerator<Uint8Array> {
  const declared = Number(headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await body.cancel().catch(() => {});
    throw new ProviderResponseTooLargeError(maxBytes);
  }

  const reader = body.getReader();
  let total = 0;
  let finished = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        return;
      }
      total += value.byteLength;
      if (total > maxBytes) throw new ProviderResponseTooLargeError(maxBytes);
      yield value;
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function readResponseText(
  response: Response,
  maxBytes: number = MAX_JSON_RESPONSE_BYTES,
): Promise<string> {
  if (!response.body) return response.text();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  for await (const chunk of readBoundedChunks(
    response.body,
    response.headers,
    maxBytes,
  )) {
    parts.push(decoder.decode(chunk, { stream: true }));
  }
  parts.push(decoder.decode());
  return parts.join("");
}

export async function readResponseBytes(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of readBoundedChunks(
    response.body,
    response.headers,
    maxBytes,
  )) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** `response.json()` with the body ceiling. A parse failure throws SyntaxError. */
export async function readResponseJson(
  response: Response,
  maxBytes: number = MAX_JSON_RESPONSE_BYTES,
): Promise<unknown> {
  if (!response.body) return response.json();
  return JSON.parse(await readResponseText(response, maxBytes));
}

export async function parseJson(
  response: Response,
): Promise<Record<string, unknown>> {
  const text = await readResponseText(response);
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
  maxEventChars: number = MAX_JSON_RESPONSE_BYTES,
): AsyncIterable<Record<string, unknown>> {
  if (!response.body) return;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let line = "";
  let skipLf = false;
  let dataLines: string[] = [];
  let dataChars = 0;
  let finished = false;

  // CR, LF, and CRLF are all valid, including CRLF split across reads.
  // Dispatch only at a blank line; EOF must not complete a partial event.
  // The stream as a whole has no length limit, but what one event holds
  // before its blank line does: a stream without line ends cannot grow it.
  function* consume(text: string): Generator<string> {
    for (const char of text) {
      if (skipLf) {
        skipLf = false;
        if (char === "\n") continue;
      }
      if (char !== "\r" && char !== "\n") {
        line += char;
        if (line.length + dataChars > maxEventChars)
          throw new ProviderResponseTooLargeError(maxEventChars);
        continue;
      }
      skipLf = char === "\r";
      const completeLine = line;
      line = "";
      if (completeLine === "") {
        const data = dataLines.join("\n");
        dataLines = [];
        dataChars = 0;
        if (data) yield data;
      } else if (completeLine.startsWith("data:")) {
        const value = completeLine.slice(5);
        dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
        dataChars += value.length;
      } else if (completeLine === "data") {
        dataLines.push("");
      }
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      finished = done;
      const text = decoder.decode(value, { stream: !done });
      for (const data of consume(text)) {
        if (data.trim() === "[DONE]") return;

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
      if (done) break;
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
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
  const details: Record<string, unknown> = {
    ...errorObj,
    ...(errorMessage ? { message: errorMessage } : {}),
    ...(typeof errorType === "string"
      ? { type: errorType, providerType: errorType }
      : {}),
    ...(typeof errorObj?.code === "string"
      ? { providerCode: errorObj.code }
      : {}),
    ...(response.status === 400 &&
    errorMessage &&
    MALFORMED_TOOL_ARGUMENTS_TEXT.test(errorMessage)
      ? { requestFault: MALFORMED_TOOL_ARGUMENTS }
      : {}),
  };

  throw new AiProviderError({
    code: isRateLimit ? "RATE_LIMITED" : "PROVIDER_ERROR",
    message: providerErrorMessage(provider, response.status, details),
    provider,
    retriable: isRateLimit || isRetriableStatus(response.status),
    statusCode: response.status,
    details,
  });
}

/**
 * `details.requestFault` of a 400 that rejects the request because a tool call
 * in its history has arguments that are not JSON. A caller can repair that
 * and send again.
 */
export const MALFORMED_TOOL_ARGUMENTS = "malformed-tool-arguments";

/**
 * DashScope and DeepSeek report that fault under a general code
 * (`invalid_request_error`, `InvalidParameter`), so their message is the only
 * mark. It is read once, here, and recorded as `details.requestFault`.
 */
const MALFORMED_TOOL_ARGUMENTS_TEXT = /function\.arguments.*JSON format/s;

function providerErrorMessage(
  provider: string,
  statusCode: number | undefined,
  details: Record<string, unknown> | undefined,
): string {
  const detail = details
    ? ` — ${typeof details.message === "string" ? details.message : JSON.stringify(details)}`
    : "";
  const status = statusCode === undefined ? "" : ` HTTP ${statusCode}`;
  return `[${provider}]${status}${detail}`;
}

/**
 * `usage` is what the provider already reported for the rejected reply; it
 * travels in `details.usage` so traces still count the spent tokens.
 */
export function createStructuredOutputError(
  provider: string,
  usage?: UsageSummary,
): AiProviderError {
  const details = usage
    ? { message: "reply does not match the requested schema", usage }
    : undefined;
  return new AiProviderError({
    code: "SCHEMA_VALIDATION_FAILED",
    message: providerErrorMessage(provider, undefined, details),
    provider,
    retriable: false,
    details,
  });
}

export function createUnsupportedModeError(
  provider: string,
  mode: string,
): AiProviderError {
  const details = { mode, message: `the ${mode} mode is not supported` };
  return new AiProviderError({
    code: "PROVIDER_ERROR",
    message: providerErrorMessage(provider, undefined, details),
    provider,
    retriable: false,
    details,
  });
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
