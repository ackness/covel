import { eq } from "drizzle-orm";

import type { DataStore, WorldRecord } from "../types.js";
import type { PgDb } from "./pg-db.js";
import { toWorldRecord } from "./pg-store-mappers.js";
import { pgWorldInsert, pgWorldUpdate } from "./pg-store-values.js";
import * as schema from "./schema.js";

export type PgWorldRecords = Pick<
  DataStore,
  "listWorlds" | "getWorld" | "upsertWorld" | "deleteWorld"
>;

export function createPgWorldRecords(getDb: () => PgDb): PgWorldRecords {
  return {
    async listWorlds(): Promise<WorldRecord[]> {
      const rows = await getDb().select().from(schema.worlds);
      return rows.map(toWorldRecord);
    },

    async getWorld(id: string): Promise<WorldRecord | null> {
      const rows = await getDb()
        .select()
        .from(schema.worlds)
        .where(eq(schema.worlds.id, id));
      return rows.length > 0 ? toWorldRecord(rows[0]) : null;
    },

    async upsertWorld(record: WorldRecord): Promise<void> {
      await getDb()
        .insert(schema.worlds)
        .values(pgWorldInsert(record))
        .onConflictDoUpdate({
          target: schema.worlds.id,
          set: pgWorldUpdate(record),
        });
    },

    async deleteWorld(id: string): Promise<void> {
      await getDb().delete(schema.worlds).where(eq(schema.worlds.id, id));
    },
  };
}
