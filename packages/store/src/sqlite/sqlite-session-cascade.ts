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
    const vectorModels = sqlite
      .prepare("SELECT id, table_name FROM vector_models")
      .all() as Array<{ id: number; table_name: string }>;
    for (const model of vectorModels) {
      const expectedTable = `vec_mem_m${model.id}`;
      if (model.table_name !== expectedTable) {
        throw new Error(
          `SqliteStore: unsafe vector table name ${JSON.stringify(model.table_name)} for model ${model.id}`,
        );
      }
      sqlite
        .prepare(`DELETE FROM ${model.table_name} WHERE session_id = ?`)
        .run(sessionId);
    }
    for (const { table } of SESSION_SCOPED_TABLES) {
      sqlite
        .prepare(`DELETE FROM ${table} WHERE session_id = ?`)
        .run(sessionId);
    }
    sqlite.prepare(`DELETE FROM ${SESSIONS_TABLE} WHERE id = ?`).run(sessionId);
  })();
}
