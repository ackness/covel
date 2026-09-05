/** Raised when `createSession` is asked to reuse an existing session id. */
export class SessionAlreadyExistsError extends Error {
  readonly code = "session_already_exists";

  constructor(readonly sessionId: string) {
    super(`Session already exists: ${sessionId}`);
    this.name = "SessionAlreadyExistsError";
  }
}

/** Raised when a global record id is already bound to another session. */
export class SessionRecordScopeConflictError extends Error {
  readonly code = "session_record_scope_conflict";

  constructor(
    readonly recordType: string,
    readonly recordId: string,
  ) {
    super(`${recordType} id belongs to another session: ${recordId}`);
    this.name = "SessionRecordScopeConflictError";
  }
}

/** Normalize the unique-constraint codes emitted by bundled SQL drivers. */
export function isUniqueConstraintError(error: unknown): boolean {
  const seen = new Set<object>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { code?: unknown; cause?: unknown };
    const code = candidate.code;
    if (
      code === "23505" ||
      (typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT"))
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}
