/**
 * Backend-agnostic instance-scoped plugin KV queries, shared by the PostgreSQL
 * and SQLite backends.
 *
 * `value` is encoded as JSON text in a `text` column on both backends so
 * serialization stays identical across SQLite, PostgreSQL, and MemoryStore.
 */

import { and, eq } from "drizzle-orm";
import type { Column, Table } from "drizzle-orm";

import type { SqlRunner } from "./sql-runner.js";
import type { DataStore, InstanceDataRecord } from "../types.js";

/** Structural handle to the `instance_data` table. */
export type InstanceDataTable = Table & {
  pluginId: Column;
  namespace: Column;
  key: Column;
};

interface InstanceDataRow {
  pluginId: string;
  namespace: string;
  key: string;
  value: string;
  createdAt: string;
  updatedAt: string;
}

export interface SqlInstanceDataRecordsDeps {
  readonly runner: SqlRunner;
  readonly instanceData: InstanceDataTable;
}

export type SqlInstanceDataRecords = Pick<
  DataStore,
  | "getInstanceData"
  | "listInstanceData"
  | "upsertInstanceData"
  | "deleteInstanceData"
  | "deletePluginInstanceData"
>;

function compareCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Deterministic code-unit order across SQLite, PostgreSQL, and MemoryStore. */
export function sortInstanceData(
  records: InstanceDataRecord[],
): InstanceDataRecord[] {
  return records.sort(
    (a, b) =>
      compareCodeUnit(a.pluginId, b.pluginId) ||
      compareCodeUnit(a.namespace, b.namespace) ||
      compareCodeUnit(a.key, b.key),
  );
}

function encodeJsonValue(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

function decodeInstanceDataRow(row: InstanceDataRow): InstanceDataRecord {
  return {
    pluginId: row.pluginId,
    namespace: row.namespace,
    key: row.key,
    value: JSON.parse(row.value) as unknown,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createSqlInstanceDataRecords(
  deps: SqlInstanceDataRecordsDeps,
): SqlInstanceDataRecords {
  const { runner, instanceData } = deps;
  return {
    async getInstanceData(
      pluginId: string,
      namespace: string,
      key: string,
    ): Promise<InstanceDataRecord | null> {
      const row = await runner.selectFirst<InstanceDataRow>(instanceData, {
        where: and(
          eq(instanceData.pluginId, pluginId),
          eq(instanceData.namespace, namespace),
          eq(instanceData.key, key),
        ),
      });
      return row ? decodeInstanceDataRow(row) : null;
    },

    async listInstanceData(
      pluginId: string,
      namespace?: string,
    ): Promise<InstanceDataRecord[]> {
      const where =
        namespace !== undefined
          ? and(
              eq(instanceData.pluginId, pluginId),
              eq(instanceData.namespace, namespace),
            )
          : eq(instanceData.pluginId, pluginId);
      const rows = await runner.select<InstanceDataRow>(instanceData, {
        where,
      });
      return sortInstanceData(rows.map(decodeInstanceDataRow));
    },

    async upsertInstanceData(record: InstanceDataRecord): Promise<void> {
      const encodedValue = encodeJsonValue(record.value);
      await runner.insert(
        instanceData,
        {
          pluginId: record.pluginId,
          namespace: record.namespace,
          key: record.key,
          value: encodedValue,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        },
        {
          target: [
            instanceData.pluginId,
            instanceData.namespace,
            instanceData.key,
          ],
          set: {
            value: encodedValue,
            updatedAt: record.updatedAt,
          },
        },
      );
    },

    async deleteInstanceData(
      pluginId: string,
      namespace: string,
      key: string,
    ): Promise<boolean> {
      const deleted = await runner.deleteReturningCount(
        instanceData,
        and(
          eq(instanceData.pluginId, pluginId),
          eq(instanceData.namespace, namespace),
          eq(instanceData.key, key),
        )!,
      );
      return deleted > 0;
    },

    async deletePluginInstanceData(pluginId: string): Promise<number> {
      return runner.deleteReturningCount(
        instanceData,
        eq(instanceData.pluginId, pluginId),
      );
    },
  };
}
