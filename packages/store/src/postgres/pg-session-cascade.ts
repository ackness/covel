import { sql } from "drizzle-orm";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PostgresJsTransaction } from "drizzle-orm/postgres-js";

import { SESSION_SCOPED_TABLES, SESSIONS_TABLE } from "../table-registry.js";
import type * as schema from "./schema.js";

type PgTx = PostgresJsTransaction<
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

/**
 * Delete every session-scoped child row, then the session itself, inside the
 * caller-provided transaction.
 *
 * The table list is derived from {@link SESSION_SCOPED_TABLES} — adding a new
 * session table to the registry extends this cascade automatically, with no
 * hand-maintained delete list to keep in sync. Identifiers come from a trusted
 * constant (never user input) and `sessionId` is bound as a parameter.
 */
export async function deletePgSessionCascade(
  tx: PgTx,
  sessionId: string,
): Promise<void> {
  for (const { table } of SESSION_SCOPED_TABLES) {
    await tx.execute(
      sql`DELETE FROM ${sql.identifier(table)} WHERE session_id = ${sessionId}`,
    );
  }
  await tx.execute(
    sql`DELETE FROM ${sql.identifier(SESSIONS_TABLE)} WHERE id = ${sessionId}`,
  );
}
