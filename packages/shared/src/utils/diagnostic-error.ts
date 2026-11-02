/** Fixed categories only: Error.name, messages, stacks and causes may contain secrets. */
export function diagnosticErrorKind(error: unknown): string {
  if (!(error instanceof Error)) return "non-error";
  switch (error.name) {
    case "AbortError":
      return "abort";
    case "TimeoutError":
      return "timeout";
    case "SyntaxError":
      return "syntax";
    case "TypeError":
      return "type";
    default:
      return "error";
  }
}
