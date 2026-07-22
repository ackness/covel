/**
 * Backend-agnostic runtime-export records, shared by the PostgreSQL and SQLite
 * backends: the `output.recordAs` publications keyed by
 * (sessionId, producerRuntimeId, recordAs, revision).
 *
 * The insert path is idempotent — it routes through
 * {@link SqlRunner.insertIgnoreReturningCount} (`ON CONFLICT DO NOTHING`,
 * returning the affected count) so a re-published revision is a no-op that
 * reports `false`, never a throw. Reads use the same uniform {@link SqlRunner}
 * surface as the other record modules; the unique index's left prefix
 * (sessionId, producerRuntimeId, recordAs) serves both the latest-lookup and
 * the list.
 */

import { and, asc, desc, eq, lte } from "drizzle-orm";
import type { Column, SQL, Table } from "drizzle-orm";

import type { InsertValueBuilders } from "./insert-values.js";
import type { JsonReader } from "./mappers.js";
import { toRuntimeExportRecord } from "./mappers.js";
import type { RuntimeExportRow } from "./mappers/export-mappers.js";
import type { SqlRunner } from "./sql-runner.js";
import type { DataStore, RuntimeExportRecord } from "../types.js";

type RuntimeExportsTable = Table & {
  sessionId: Column;
  producerRuntimeId: Column;
  recordAs: Column;
  revision: Column;
  committedAt: Column;
};

export interface SqlExportTables {
  readonly runtimeExports: RuntimeExportsTable;
}

export interface SqlExportRecordsDeps {
  readonly runner: SqlRunner;
  readonly tables: SqlExportTables;
  readonly json: JsonReader;
  readonly values: Pick<InsertValueBuilders, "runtimeExportInsert">;
}

export type SqlExportRecords = Pick<
  DataStore,
  "appendRuntimeExport" | "getLatestRuntimeExport" | "listRuntimeExports"
>;

/** `and(...conds)` over the defined predicates, or `undefined` when none. */
function allOf(conds: readonly (SQL | undefined)[]): SQL | undefined {
  const defined = conds.filter((c): c is SQL => c !== undefined);
  return defined.length > 0 ? and(...defined) : undefined;
}

export function createSqlExportRecords(
  deps: SqlExportRecordsDeps,
): SqlExportRecords {
  const { runner, tables, json, values } = deps;
  const { runtimeExports } = tables;

  return {
    async appendRuntimeExport(record: RuntimeExportRecord): Promise<boolean> {
      const inserted = await runner.insertIgnoreReturningCount(
        runtimeExports,
        values.runtimeExportInsert(record),
        [
          runtimeExports.sessionId,
          runtimeExports.producerRuntimeId,
          runtimeExports.recordAs,
          runtimeExports.revision,
        ],
      );
      return inserted === 1;
    },

    async getLatestRuntimeExport(
      sessionId: string,
      producerRuntimeId: string,
      recordAs: string,
      opts?: { readonly atOrBefore?: string },
    ): Promise<RuntimeExportRecord | null> {
      const row = await runner.selectFirst<RuntimeExportRow>(runtimeExports, {
        where: allOf([
          eq(runtimeExports.sessionId, sessionId),
          eq(runtimeExports.producerRuntimeId, producerRuntimeId),
          eq(runtimeExports.recordAs, recordAs),
          opts?.atOrBefore !== undefined
            ? lte(runtimeExports.committedAt, opts.atOrBefore)
            : undefined,
        ]),
        // Highest revision first — `revision` is the authoritative monotone
        // sequence, so the frozen-read cutoff filters on committedAt then this
        // picks the latest surviving revision.
        orderBy: [desc(runtimeExports.revision)],
        limit: 1,
      });
      return row ? toRuntimeExportRecord(row, json) : null;
    },

    async listRuntimeExports(
      sessionId: string,
      filter?: {
        readonly producerRuntimeId?: string;
        readonly recordAs?: string;
      },
    ): Promise<readonly RuntimeExportRecord[]> {
      const rows = await runner.select<RuntimeExportRow>(runtimeExports, {
        where: allOf([
          eq(runtimeExports.sessionId, sessionId),
          filter?.producerRuntimeId !== undefined
            ? eq(runtimeExports.producerRuntimeId, filter.producerRuntimeId)
            : undefined,
          filter?.recordAs !== undefined
            ? eq(runtimeExports.recordAs, filter.recordAs)
            : undefined,
        ]),
        orderBy: [
          asc(runtimeExports.producerRuntimeId),
          asc(runtimeExports.recordAs),
          asc(runtimeExports.revision),
        ],
      });
      return rows.map((row) => toRuntimeExportRecord(row, json));
    },
  };
}
