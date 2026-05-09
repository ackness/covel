import { and, eq } from "drizzle-orm";

import type { DataStore, PluginConfigRecord } from "../types.js";
import * as schema from "./schema.js";
import { toJson, toPluginConfigRecord } from "./sqlite-store-mappers.js";
import type { SqliteDb } from "./sqlite-types.js";

export type SqlitePluginConfigs = Pick<
  DataStore,
  "savePluginConfig" | "getPluginConfig"
>;

export function createSqlitePluginConfigs(db: SqliteDb): SqlitePluginConfigs {
  return {
    async savePluginConfig(record: PluginConfigRecord): Promise<void> {
      db.insert(schema.pluginConfigs)
        .values({
          id: record.id,
          sessionId: record.sessionId,
          pluginId: record.pluginId,
          config: toJson(record.config),
          updatedAt: record.updatedAt,
        })
        .onConflictDoUpdate({
          target: schema.pluginConfigs.id,
          set: {
            config: toJson(record.config),
            updatedAt: record.updatedAt,
          },
        })
        .run();
    },

    async getPluginConfig(
      sessionId: string,
      pluginId: string,
    ): Promise<PluginConfigRecord | null> {
      const row = db
        .select()
        .from(schema.pluginConfigs)
        .where(
          and(
            eq(schema.pluginConfigs.sessionId, sessionId),
            eq(schema.pluginConfigs.pluginId, pluginId),
          ),
        )
        .get();
      return row ? toPluginConfigRecord(row) : null;
    },
  };
}
