/**
 * Backend-agnostic plugin-config queries (save / get), shared by the PostgreSQL
 * and SQLite backends.
 *
 * Previously these lived in two unrelated files — `postgres/pg-session-content-
 * records.ts` (bundled with the content surface) and the standalone
 * `sqlite/sqlite-plugin-configs.ts`. They were mirrors differing only in the
 * sync/async terminal and the JSON serialization, both injected here via the
 * {@link SqlRunner}, {@link JsonReader}, and value builders. The two backend
 * adapters keep their existing factory boundaries and delegate to this module.
 */

import { and, eq } from "drizzle-orm";
import type { Column, Table } from "drizzle-orm";

import type { InsertValueBuilders } from "./insert-values.js";
import type { JsonReader } from "./mappers.js";
import { toPluginConfigRecord } from "./mappers.js";
import type { PluginConfigRow } from "./mappers/plugin-mappers.js";
import type { SqlRunner } from "./sql-runner.js";
import type { DataStore, PluginConfigRecord } from "../types.js";

type PluginConfigsTable = Table & {
  id: Column;
  sessionId: Column;
  pluginId: Column;
};

export interface SqlPluginConfigTables {
  readonly pluginConfigs: PluginConfigsTable;
}

export interface SqlPluginConfigDeps {
  readonly runner: SqlRunner;
  readonly tables: SqlPluginConfigTables;
  readonly json: JsonReader;
  readonly values: Pick<
    InsertValueBuilders,
    "pluginConfigInsert" | "pluginConfigUpdate"
  >;
}

export type SqlPluginConfigRecords = Pick<
  DataStore,
  "savePluginConfig" | "getPluginConfig"
>;

export function createSqlPluginConfigRecords(
  deps: SqlPluginConfigDeps,
): SqlPluginConfigRecords {
  const { runner, tables, json, values } = deps;
  const { pluginConfigs } = tables;

  return {
    async savePluginConfig(record: PluginConfigRecord): Promise<void> {
      await runner.insert(pluginConfigs, values.pluginConfigInsert(record), {
        target: pluginConfigs.id,
        set: values.pluginConfigUpdate(record),
      });
    },

    async getPluginConfig(
      sessionId: string,
      pluginId: string,
    ): Promise<PluginConfigRecord | null> {
      const row = await runner.selectFirst<PluginConfigRow>(pluginConfigs, {
        where: and(
          eq(pluginConfigs.sessionId, sessionId),
          eq(pluginConfigs.pluginId, pluginId),
        ),
      });
      return row ? toPluginConfigRecord(row, json) : null;
    },
  };
}
