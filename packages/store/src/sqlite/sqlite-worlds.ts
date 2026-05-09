import { eq } from "drizzle-orm";

import type { DataStore, WorldRecord } from "../types.js";
import * as schema from "./schema.js";
import { toWorldRecord } from "./sqlite-store-mappers.js";
import { sqliteWorldInsert, sqliteWorldUpdate } from "./sqlite-store-values.js";
import type { SqliteDb } from "./sqlite-types.js";

export type SqliteWorlds = Pick<
  DataStore,
  "listWorlds" | "getWorld" | "upsertWorld" | "deleteWorld"
>;

export function createSqliteWorlds(db: SqliteDb): SqliteWorlds {
  return {
    async listWorlds(): Promise<WorldRecord[]> {
      const rows = db.select().from(schema.worlds).all();
      return rows.map(toWorldRecord);
    },

    async getWorld(id: string): Promise<WorldRecord | null> {
      const row = db
        .select()
        .from(schema.worlds)
        .where(eq(schema.worlds.id, id))
        .get();
      return row ? toWorldRecord(row) : null;
    },

    async upsertWorld(record: WorldRecord): Promise<void> {
      db.insert(schema.worlds)
        .values(sqliteWorldInsert(record))
        .onConflictDoUpdate({
          target: schema.worlds.id,
          set: sqliteWorldUpdate(record),
        })
        .run();
    },

    async deleteWorld(id: string): Promise<void> {
      db.delete(schema.worlds).where(eq(schema.worlds.id, id)).run();
    },
  };
}
