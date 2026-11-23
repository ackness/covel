/**
 * Backend-agnostic persistent plugin grant queries, shared by the PostgreSQL
 * and SQLite backends.
 *
 * JSON fields (`grantedCapabilities` and `decisions`) are encoded as JSON text
 * on both backends so serialization and ordering stay identical across stores.
 */

import { eq } from "drizzle-orm";
import type { Column, Table } from "drizzle-orm";
import {
  pluginCapabilitiesSchema,
  type PluginCapabilities,
} from "@covel/shared";
import { pluginGrantDecisionsSchema } from "@covel/shared/permissions";

import type { SqlRunner } from "./sql-runner.js";
import type { DataStore, PluginGrantRecord } from "../types.js";

/** Structural handle to the `plugin_grants` table. */
export type PluginGrantsTable = Table & { pluginId: Column };

interface PluginGrantRow {
  pluginId: string;
  version: string;
  contentDigest: string;
  grantedCapabilities: string;
  decisions: string;
  grantedAt: string;
  updatedAt: string;
}

export interface SqlPluginGrantRecordsDeps {
  readonly runner: SqlRunner;
  readonly pluginGrants: PluginGrantsTable;
}

export type SqlPluginGrantRecords = Pick<
  DataStore,
  | "listPluginGrants"
  | "getPluginGrant"
  | "upsertPluginGrant"
  | "deletePluginGrant"
>;

/** Plugin ID order by code unit, identical across backends. */
export function sortPluginGrants(
  records: PluginGrantRecord[],
): PluginGrantRecord[] {
  return records.sort((a, b) =>
    a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : 0,
  );
}

function decodeGrantRow(row: PluginGrantRow): PluginGrantRecord {
  return {
    pluginId: row.pluginId,
    version: row.version,
    contentDigest: row.contentDigest,
    grantedCapabilities: pluginCapabilitiesSchema.parse(
      JSON.parse(row.grantedCapabilities),
    ) as PluginCapabilities,
    decisions: pluginGrantDecisionsSchema.parse(JSON.parse(row.decisions)),
    grantedAt: row.grantedAt,
    updatedAt: row.updatedAt,
  };
}

export function createSqlPluginGrantRecords(
  deps: SqlPluginGrantRecordsDeps,
): SqlPluginGrantRecords {
  const { runner, pluginGrants } = deps;
  return {
    async listPluginGrants(): Promise<PluginGrantRecord[]> {
      const rows = await runner.select<PluginGrantRow>(pluginGrants);
      return sortPluginGrants(rows.map(decodeGrantRow));
    },

    async getPluginGrant(pluginId: string): Promise<PluginGrantRecord | null> {
      const row = await runner.selectFirst<PluginGrantRow>(pluginGrants, {
        where: eq(pluginGrants.pluginId, pluginId),
      });
      return row ? decodeGrantRow(row) : null;
    },

    async upsertPluginGrant(record: PluginGrantRecord): Promise<void> {
      const grantedCapabilities = JSON.stringify(record.grantedCapabilities);
      const decisions = JSON.stringify(record.decisions);
      await runner.insert(
        pluginGrants,
        {
          pluginId: record.pluginId,
          version: record.version,
          contentDigest: record.contentDigest,
          grantedCapabilities,
          decisions,
          grantedAt: record.grantedAt,
          updatedAt: record.updatedAt,
        },
        {
          target: pluginGrants.pluginId,
          set: {
            version: record.version,
            contentDigest: record.contentDigest,
            grantedCapabilities,
            decisions,
            grantedAt: record.grantedAt,
            updatedAt: record.updatedAt,
          },
        },
      );
    },

    async deletePluginGrant(pluginId: string): Promise<void> {
      await runner.delete(pluginGrants, eq(pluginGrants.pluginId, pluginId));
    },
  };
}
