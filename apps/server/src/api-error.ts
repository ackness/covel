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
export interface ApiErrorResponse<Code extends string = string> {
  readonly error: string;
  readonly code?: Code;
  readonly details?: unknown;
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
