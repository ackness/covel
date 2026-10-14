/** Raised when `createSession` is asked to reuse an existing session id. */
export class SessionAlreadyExistsError extends Error {
  readonly code = "session_already_exists";

  constructor(readonly sessionId: string) {
    super(`Session already exists: ${sessionId}`);
    this.name = "SessionAlreadyExistsError";
  }
}

/**
 * Raised when a write needs the session row and it is gone. A caller that
 * raced with session deletion can tell this from a database failure.
 */
export class SessionNotFoundError extends Error {
  readonly code = "session_not_found";

  constructor(readonly sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.name = "SessionNotFoundError";
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

/**
 * Raised at startup when an SQL database was written by a Covel build with
 * another data schema. Covel does not migrate stored data, so it refuses to
 * open the database instead of failing later on a missing column. `found` is
 * null for a database written before the version was recorded.
 */
export class StoreSchemaVersionError extends Error {
  readonly code = "store_schema_incompatible";

  constructor(
    readonly backend: "sqlite" | "pg",
    readonly found: number | null,
    readonly expected: number,
    readonly missingColumns: readonly string[] = [],
  ) {
    super(describeSchemaMismatch(backend, found, expected, missingColumns));
    this.name = "StoreSchemaVersionError";
  }
}

function describeSchemaMismatch(
  backend: "sqlite" | "pg",
  found: number | null,
  expected: number,
  missingColumns: readonly string[],
): string {
  const label = backend === "sqlite" ? "SQLite" : "PostgreSQL";
  const cause =
    found === null
      ? `was written by an older Covel and lacks columns this version needs (${missingColumns.slice(0, 5).join(", ")}${missingColumns.length > 5 ? ", ..." : ""})`
      : found > expected
        ? `was written by a newer Covel (data schema ${found}; this version uses ${expected})`
        : `was written by an older Covel (data schema ${found}; this version uses ${expected})`;
  const remedy =
    backend === "sqlite"
      ? "Back up the database file (with its -wal and -shm files), then start this version with a new data directory or SQLITE_PATH."
      : "Back up the database, then point DATABASE_URL at a new, empty database.";
  return `The ${label} database ${cause}. Covel does not migrate stored data and will not open it. ${remedy}`;
}

/** SQLite extended result codes for a primary-key and a unique violation. */
const SQLITE_UNIQUE_VIOLATIONS = new Set([1555, 2067]);

/** Normalize the unique-constraint codes emitted by bundled SQL drivers. */
export function isUniqueConstraintError(error: unknown): boolean {
  const seen = new Set<object>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as {
      code?: unknown;
      errcode?: unknown;
      cause?: unknown;
    };
    if (
      candidate.code === "23505" ||
      (candidate.code === "ERR_SQLITE_ERROR" &&
        SQLITE_UNIQUE_VIOLATIONS.has(candidate.errcode as number))
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}
