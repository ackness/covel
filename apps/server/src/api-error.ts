import type { Context, ErrorHandler } from "hono";
import { z, type ZodType } from "zod";
import type {
  ApiErrorResponse,
  ApiListResponse,
  ApiOkResponse,
} from "@covel/shared";
import { SessionLockTimeoutError } from "./lib/session-lock.js";

export type { ApiErrorResponse } from "@covel/shared";

/**
 * Standard API error envelope.
 *
 * Every JSON error response from the API should converge on this shape:
 *
 *   { "error": string, "code"?: string, "details"?: unknown }
 *
 * - `error`   — human-readable message (always present).
 * - `code`    — stable machine-readable code (optional; routes that gate UI
 *               behaviour on a code should always set it).
 * - `details` — structured diagnostics (optional; e.g. Zod validation errors).
 *
 * Builder:
 * - {@link errorBody}     — `(message, { code?, details? })` → flexible envelope
 *                           covering the common `{ error }` / `{ error, code }` /
 *                           `{ error, details }` cases. The single factory all
 *                           JSON error responses converge on.
 */
/**
 * Build a flexible error envelope. Message first; `code` and `details` are
 * optional and omitted from the body when not provided.
 */
export function errorBody<Code extends string = string>(
  message: string,
  options?: { code?: Code; details?: unknown },
): ApiErrorResponse<Code> {
  const body: { error: string; code?: Code; details?: unknown } = {
    error: message,
  };
  if (options?.code !== undefined) body.code = options.code;
  if (options?.details !== undefined) body.details = options.details;
  return body;
}

/** Build the only envelope used by ordinary collection endpoints. */
export function listBody<T>(items: readonly T[]): ApiListResponse<T> {
  return { items };
}

/** Build a successful command acknowledgement with optional result metadata. */
export function okBody<
  Details extends Readonly<Record<string, unknown>> = Readonly<
    Record<never, never>
  >,
>(details?: Details): ApiOkResponse<Details> {
  return { ...details, ok: true } as ApiOkResponse<Details>;
}

/**
 * Parse a JSON object request body, or return a 400 envelope Response so a malformed
 * body converges on the standard error shape instead of throwing into the
 * global 500 handler. Callers do
 * `const parsed = await readJsonBody(c); if (parsed instanceof Response) return parsed;`
 * then read `parsed.body`. Pass a type param to preserve the shape the route
 * expects (`readJsonBody<Record<string, unknown>>(c)`). Route-specific fields
 * still require validation; null, arrays, and scalar bodies are rejected here.
 */
const jsonObjectBodySchema = z.record(z.string(), z.unknown());

export async function readJsonBody<T = unknown>(
  c: Context,
): Promise<{ body: T } | Response> {
  try {
    const parsed = jsonObjectBodySchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        errorBody("Body must be a JSON object", {
          code: "invalid_request_body",
        }),
        400,
      );
    }
    return { body: parsed.data as T };
  } catch {
    return c.json(
      errorBody("Invalid JSON body", { code: "invalid_json_body" }),
      400,
    );
  }
}

/** Parse and validate a JSON body with the standard coded 400 response. */
export async function parseJsonBody<Schema extends ZodType>(
  c: Context,
  schema: Schema,
): Promise<{ body: Schema["_output"] } | Response> {
  const json = await readJsonBody(c);
  if (json instanceof Response) return json;
  const parsed = schema.safeParse(json.body);
  if (!parsed.success) {
    return c.json(
      errorBody("Invalid request body", {
        code: "invalid_request_body",
        details: parsed.error.flatten(),
      }),
      400,
    );
  }
  return { body: parsed.data };
}

/**
 * Redact sensitive query params (signed media `token`, SSE `session_token`
 * owner auth) from a URL before it hits logs — the raw string is kept
 * everywhere else (routing, response).
 */
const SENSITIVE_QUERY_PARAMS = ["token", "session_token"];

export function redactSensitiveQueryParams(url: string): string {
  try {
    const parsed = new URL(url);
    for (const param of SENSITIVE_QUERY_PARAMS) {
      if (parsed.searchParams.has(param)) {
        parsed.searchParams.set(param, "[redacted]");
      }
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

/** Redact sensitive query values inside preformatted request log lines. */
export function redactSensitiveQueryParamsInText(text: string): string {
  return text.replace(/(?:https?:\/\/|\/)[^\s]+/gi, (candidate) => {
    try {
      const absolute = /^https?:\/\//i.test(candidate);
      const parsed = new URL(candidate, "http://redaction.invalid");
      for (const param of SENSITIVE_QUERY_PARAMS) {
        if (parsed.searchParams.has(param)) {
          parsed.searchParams.set(param, "[redacted]");
        }
      }
      const redacted = absolute
        ? parsed.toString()
        : `${parsed.pathname}${parsed.search}${parsed.hash}`;
      return redacted.replaceAll("%5Bredacted%5D", "[redacted]");
    } catch {
      return candidate;
    }
  });
}

/**
 * Single wire representation of "lost the race for the session lock".
 * Shared by the JSON error handler below and the actions SSE stream
 * (`routes/api/actions.ts`), which cannot return a coded 503 once its stream
 * is open and therefore emits the same fixed message + code inside its
 * `error.occurred` payload. The raw `SessionLockTimeoutError` message names
 * the session and lock-pool internals, so it must never cross the wire.
 */
export const SESSION_BUSY_MESSAGE = "Session is busy, please retry";
export const SESSION_BUSY_CODE = "session_busy";

/**
 * Global `app.onError` handler factory. Logs every unhandled error WITH request
 * context (method + full URL, sensitive query params redacted) under
 * `logPrefix` so any 500 is greppable, then returns the standard envelope —
 * the raw message in dev, a generic string in prod (`isDev` false) so
 * stacks/paths never leak.
 *
 * One error is not a server fault and is mapped instead of being bucketed as a
 * 500: {@link SessionLockTimeoutError}. See below.
 */
export function makeErrorHandler(
  logPrefix: string,
  isDev: boolean,
): ErrorHandler {
  return (err, c) => {
    const message = err instanceof Error ? err.message : String(err);

    // Losing the race for a session lock means another turn on the same
    // session still holds it — with a background image generation that can be
    // minutes — not that anything broke. The caller can succeed by retrying,
    // so it is a coded, retryable 503 rather than a generic 500. The raw
    // message names the session and internals, so only a fixed string crosses
    // the wire; the detail stays in the log.
    if (err instanceof SessionLockTimeoutError) {
      console.warn(
        `${logPrefix}: ${c.req.method} ${redactSensitiveQueryParams(c.req.url)} — ${message}`,
      );
      return c.json(
        errorBody(SESSION_BUSY_MESSAGE, { code: SESSION_BUSY_CODE }),
        503,
      );
    }

    console.error(
      `${logPrefix}: ${c.req.method} ${redactSensitiveQueryParams(c.req.url)} — ${message}`,
      err,
    );
    return c.json(errorBody(isDev ? message : "Internal server error"), 500);
  };
}
