import type Database from "better-sqlite3";

import { SESSION_SCOPED_TABLES, SESSIONS_TABLE } from "../table-registry.js";

/**
 * Delete every session-scoped child row, then the session itself, in one atomic
 * SQLite transaction.
 *
 * The table list is derived from {@link SESSION_SCOPED_TABLES} — adding a new
 * session table to the registry extends this cascade automatically. Table names
 * come from a trusted constant (never user input); `sessionId` is bound as a
 * parameter.
 */
export function deleteSqliteSessionCascade(
  sqlite: Database.Database,
  sessionId: string,
): void {
  sqlite.transaction(() => {
    for (const { table } of SESSION_SCOPED_TABLES) {
      sqlite
        .prepare(`DELETE FROM ${table} WHERE session_id = ?`)
        .run(sessionId);
    }
    sqlite.prepare(`DELETE FROM ${SESSIONS_TABLE} WHERE id = ?`).run(sessionId);
  })();
}
