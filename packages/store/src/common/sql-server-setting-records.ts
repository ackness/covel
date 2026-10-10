/**
 * Backend-agnostic server-setting queries, shared by the PostgreSQL and SQLite
 * backends in the same way as `sql-world-records.ts`.
 *
 * The value is JSON text in a `text` column on both backends, encoded here.
 * A `jsonb` column would not keep a string apart from the JSON it spells: the
 * driver layer parses every string it reads, so `"30"` comes back as `30`.
 */

import { eq } from "drizzle-orm";
import type { Column, Table } from "drizzle-orm";

import type { SqlRunner } from "./sql-runner.js";
import type { DataStore, ServerSettingRecord } from "../types.js";

/** Structural handle to the `server_settings` table. */
export type ServerSettingsTable = Table & { key: Column };

interface ServerSettingRow {
  key: string;
  value: string;
  updatedAt: string;
}

export interface SqlServerSettingRecordsDeps {
  readonly runner: SqlRunner;
  readonly serverSettings: ServerSettingsTable;
}

export type SqlServerSettingRecords = Pick<
  DataStore,
  "listServerSettings" | "setServerSetting" | "deleteServerSetting"
>;

/** Key order by code unit, the same on every backend. */
export function sortServerSettings(
  records: ServerSettingRecord[],
): ServerSettingRecord[] {
  return records.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export function createSqlServerSettingRecords(
  deps: SqlServerSettingRecordsDeps,
): SqlServerSettingRecords {
  const { runner, serverSettings } = deps;
  return {
    async listServerSettings(): Promise<ServerSettingRecord[]> {
      const rows = await runner.select<ServerSettingRow>(serverSettings);
      return sortServerSettings(
        rows.map((row) => ({
          key: row.key,
          value: JSON.parse(row.value) as unknown,
          updatedAt: row.updatedAt,
        })),
      );
    },

    async setServerSetting(record: ServerSettingRecord): Promise<void> {
      const value = JSON.stringify(record.value);
      await runner.insert(
        serverSettings,
        { key: record.key, value, updatedAt: record.updatedAt },
        {
          target: serverSettings.key,
          set: { value, updatedAt: record.updatedAt },
        },
      );
    },

    async deleteServerSetting(key: string): Promise<void> {
      await runner.delete(serverSettings, eq(serverSettings.key, key));
    },
  };
}
