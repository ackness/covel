/** Error vocabulary shared by plugin tools and their hosts. */
export const TOOL_ERROR_CODES = [
  "invalid-input",
  "not-found",
  "ambiguous",
  "refused",
  "unavailable",
  "timeout",
  "conflict",
  "cancelled",
  "internal",
] as const;

export type PluginToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

/** A correctable tool failure whose message and hint may be shown to the model. */
export class ToolError extends Error {
  override readonly name: string = "ToolError";
  readonly code: PluginToolErrorCode;
  readonly hint?: string;

  constructor(
    code: PluginToolErrorCode,
    message: string,
    options?: { hint?: string },
  ) {
    super(message);
    this.code = code;
    this.hint = options?.hint;
  }
}

/** Recognize subclasses and errors created by another copy of the SDK. */
export function isToolError(value: unknown): value is ToolError {
  return (
    value instanceof Error &&
    "code" in value &&
    TOOL_ERROR_CODES.some((code) => code === value.code)
  );
}
