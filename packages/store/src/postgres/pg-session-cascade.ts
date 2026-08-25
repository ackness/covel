import { sql } from "drizzle-orm";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PostgresJsTransaction } from "drizzle-orm/postgres-js";

import { SESSION_SCOPED_TABLES, SESSIONS_TABLE } from "../table-registry.js";
import * as schema from "./schema.js";

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
  // Lock the parent before touching any physical vector table. Vector upserts
  // hold FOR KEY SHARE on this row through their INSERT, so the two possible
  // orders are both safe: an earlier upsert commits before this cascade and is
  // deleted below, while a later upsert waits and then observes no session.
  await tx.execute(
    sql`SELECT id FROM ${sql.identifier(SESSIONS_TABLE)} WHERE id = ${sessionId} FOR UPDATE`,
  );
  const vectorModels = await tx
    .select({
      id: schema.vectorModels.id,
      tableName: schema.vectorModels.tableName,
    })
    .from(schema.vectorModels);
  for (const model of vectorModels) {
    const expectedTable = `vec_mem_m${model.id}`;
    if (model.tableName !== expectedTable) {
      throw new Error(
        `PgStore: unsafe vector table name ${JSON.stringify(model.tableName)} for model ${model.id}`,
      );
    }
    await tx.execute(
      sql`DELETE FROM ${sql.identifier(model.tableName)} WHERE session_id = ${sessionId}`,
    );
  }
  for (const { table } of SESSION_SCOPED_TABLES) {
    await tx.execute(
      sql`DELETE FROM ${sql.identifier(table)} WHERE session_id = ${sessionId}`,
    );
  }
  await tx.execute(
    sql`DELETE FROM ${sql.identifier(SESSIONS_TABLE)} WHERE id = ${sessionId}`,
  );
}
