/**
 * Backend-agnostic state queries (state schemas / entries / changes), shared by
 * the PostgreSQL and SQLite backends.
 *
 * Previously `postgres/pg-state-records.ts` and `sqlite/sqlite-state.ts` were
 * mirrors differing only in the sync/async terminal and the JSON serialization.
 * Both differences are injected via the {@link SqlRunner}, {@link JsonReader},
 * and the value builders ({@link InsertValueBuilders}), so this is the single
 * source of truth for the state surface.
 */

import { and, asc, eq } from "drizzle-orm";
import type { Column, Table } from "drizzle-orm";

import type { InsertValueBuilders } from "./insert-values.js";
import type { JsonReader } from "./mappers.js";
import {
  toStateChangeRecord,
  toStateEntryRecord,
  toStateSchemaRecord,
} from "./mappers.js";
import type {
  StateChangeRow,
  StateEntryRow,
  StateSchemaRow,
} from "./mappers/state-mappers.js";
import type { SqlRunner } from "./sql-runner.js";
import type {
  DataStore,
  StateChangeRecord,
  StateEntryRecord,
  StateSchemaRecord,
} from "../types.js";

type StateSchemasTable = Table & {
  id: Column;
  sessionId: Column;
  tableName: Column;
};
type StateEntriesTable = Table & {
  sessionId: Column;
  tableName: Column;
  fieldName: Column;
};
type StateChangesTable = Table & {
  sessionId: Column;
  tableName: Column;
  fieldName: Column;
  createdAt: Column;
};

export interface SqlStateTables {
  readonly stateSchemas: StateSchemasTable;
  readonly stateEntries: StateEntriesTable;
  readonly stateChanges: StateChangesTable;
}

export interface SqlStateRecordsDeps {
  readonly runner: SqlRunner;
  readonly tables: SqlStateTables;
  readonly json: JsonReader;
  readonly values: Pick<
    InsertValueBuilders,
    | "stateSchemaInsert"
    | "stateSchemaUpdate"
    | "stateEntryInsert"
    | "stateEntryUpdate"
    | "stateChangeInsert"
  >;
}

export type SqlStateRecords = Pick<
  DataStore,
  | "saveStateSchema"
  | "listStateSchemas"
  | "deleteStateSchema"
  | "getStateEntry"
  | "upsertStateEntry"
  | "listStateEntries"
  | "addStateChange"
  | "listStateChanges"
>;

export function createSqlStateRecords(
  deps: SqlStateRecordsDeps,
): SqlStateRecords {
  const { runner, tables, json, values } = deps;
  const { stateSchemas, stateEntries, stateChanges } = tables;

  return {
    async saveStateSchema(record: StateSchemaRecord): Promise<void> {
      await runner.insert(stateSchemas, values.stateSchemaInsert(record), {
        target: stateSchemas.id,
        set: values.stateSchemaUpdate(record),
      });
    },

    async listStateSchemas(sessionId: string): Promise<StateSchemaRecord[]> {
      const rows = await runner.select<StateSchemaRow>(stateSchemas, {
        where: eq(stateSchemas.sessionId, sessionId),
      });
      return rows.map((row) => toStateSchemaRecord(row, json));
    },

    async deleteStateSchema(
      sessionId: string,
      tableName: string,
    ): Promise<void> {
      await runner.delete(
        stateSchemas,
        and(
          eq(stateSchemas.sessionId, sessionId),
          eq(stateSchemas.tableName, tableName),
        ),
      );
    },

    async getStateEntry(
      sessionId: string,
      tableName: string,
      fieldName: string,
    ): Promise<StateEntryRecord | null> {
      const row = await runner.selectFirst<StateEntryRow>(stateEntries, {
        where: and(
          eq(stateEntries.sessionId, sessionId),
          eq(stateEntries.tableName, tableName),
          eq(stateEntries.fieldName, fieldName),
        ),
      });
      return row ? toStateEntryRecord(row, json) : null;
    },

    async upsertStateEntry(record: StateEntryRecord): Promise<void> {
      await runner.insert(stateEntries, values.stateEntryInsert(record), {
        target: [
          stateEntries.sessionId,
          stateEntries.tableName,
          stateEntries.fieldName,
        ],
        set: values.stateEntryUpdate(record),
      });
    },

    async listStateEntries(
      sessionId: string,
      tableName: string,
    ): Promise<StateEntryRecord[]> {
      const rows = await runner.select<StateEntryRow>(stateEntries, {
        where: and(
          eq(stateEntries.sessionId, sessionId),
          eq(stateEntries.tableName, tableName),
        ),
      });
      return rows.map((row) => toStateEntryRecord(row, json));
    },

    async addStateChange(record: StateChangeRecord): Promise<void> {
      await runner.insert(stateChanges, values.stateChangeInsert(record));
    },

    async listStateChanges(
      sessionId: string,
      tableName: string,
      fieldName: string,
    ): Promise<StateChangeRecord[]> {
      const rows = await runner.select<StateChangeRow>(stateChanges, {
        where: and(
          eq(stateChanges.sessionId, sessionId),
          eq(stateChanges.tableName, tableName),
          eq(stateChanges.fieldName, fieldName),
        ),
        orderBy: [asc(stateChanges.createdAt)],
      });
      return rows.map((row) => toStateChangeRecord(row, json));
    },
  };
}
