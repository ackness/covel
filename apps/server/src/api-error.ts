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
 * Builders:
 * - {@link apiError}      — `(code, message)` → `{ error, code }`. The original
 *                           helper, used by config / auth / rate-limit routes
 *                           that always pin a code. Kept for back-compat.
 * - {@link errorBody}     — `(message, { code?, details? })` → flexible envelope
 *                           for the common `{ error }` / `{ error, details }`
 *                           cases that previously used ad-hoc object literals.
 */
export interface ApiErrorResponse<Code extends string = string> {
  readonly error: string;
  readonly code?: Code;
  readonly details?: unknown;
}

/** @deprecated Prefer {@link ApiErrorResponse}. */
export type ApiErrorBody<Code extends string = string> = ApiErrorResponse<Code>;

/**
 * Build `{ error, code }`. Original signature — `code` first — preserved so the
 * existing config / auth / rate-limit call sites keep working unchanged.
 */
export function apiError<Code extends string>(
  code: Code,
  message: string,
): ApiErrorResponse<Code> {
  return { error: message, code };
}

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
