import { and, eq } from "drizzle-orm";

import type {
  DataStore,
  StateChangeRecord,
  StateEntryRecord,
  StateSchemaRecord,
} from "../types.js";
import * as schema from "./schema.js";
import {
  toJson,
  toStateChangeRecord,
  toStateEntryRecord,
  toStateSchemaRecord,
} from "./sqlite-store-mappers.js";
import {
  sqliteStateEntryInsert,
  sqliteStateEntryUpdate,
} from "./sqlite-store-values.js";
import type { SqliteDb } from "./sqlite-types.js";

export type SqliteState = Pick<
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

export function createSqliteState(db: SqliteDb): SqliteState {
  return {
    async saveStateSchema(record: StateSchemaRecord): Promise<void> {
      db.insert(schema.stateSchemas)
        .values({
          id: record.id,
          sessionId: record.sessionId,
          tableName: record.tableName,
          schema: toJson(record.schema),
          createdAt: record.createdAt,
        })
        .onConflictDoUpdate({
          target: schema.stateSchemas.id,
          set: {
            schema: toJson(record.schema),
          },
        })
        .run();
    },

    async listStateSchemas(sessionId: string): Promise<StateSchemaRecord[]> {
      const rows = db
        .select()
        .from(schema.stateSchemas)
        .where(eq(schema.stateSchemas.sessionId, sessionId))
        .all();
      return rows.map(toStateSchemaRecord);
    },

    async deleteStateSchema(
      sessionId: string,
      tableName: string,
    ): Promise<void> {
      db.delete(schema.stateSchemas)
        .where(
          and(
            eq(schema.stateSchemas.sessionId, sessionId),
            eq(schema.stateSchemas.tableName, tableName),
          ),
        )
        .run();
    },

    async getStateEntry(
      sessionId: string,
      tableName: string,
      fieldName: string,
    ): Promise<StateEntryRecord | null> {
      const row = db
        .select()
        .from(schema.stateEntries)
        .where(
          and(
            eq(schema.stateEntries.sessionId, sessionId),
            eq(schema.stateEntries.tableName, tableName),
            eq(schema.stateEntries.fieldName, fieldName),
          ),
        )
        .get();
      return row ? toStateEntryRecord(row) : null;
    },

    async upsertStateEntry(record: StateEntryRecord): Promise<void> {
      db.insert(schema.stateEntries)
        .values(sqliteStateEntryInsert(record))
        .onConflictDoUpdate({
          target: [
            schema.stateEntries.sessionId,
            schema.stateEntries.tableName,
            schema.stateEntries.fieldName,
          ],
          set: sqliteStateEntryUpdate(record),
        })
        .run();
    },

    async listStateEntries(
      sessionId: string,
      tableName: string,
    ): Promise<StateEntryRecord[]> {
      const rows = db
        .select()
        .from(schema.stateEntries)
        .where(
          and(
            eq(schema.stateEntries.sessionId, sessionId),
            eq(schema.stateEntries.tableName, tableName),
          ),
        )
        .all();
      return rows.map(toStateEntryRecord);
    },

    async addStateChange(record: StateChangeRecord): Promise<void> {
      db.insert(schema.stateChanges)
        .values({
          id: record.id,
          sessionId: record.sessionId,
          tableName: record.tableName,
          fieldName: record.fieldName,
          value: toJson(record.value),
          changedBy: record.changedBy,
          turnId: record.turnId,
          reason: record.reason ?? null,
          createdAt: record.createdAt,
        })
        .run();
    },

    async listStateChanges(
      sessionId: string,
      tableName: string,
      fieldName: string,
    ): Promise<StateChangeRecord[]> {
      const rows = db
        .select()
        .from(schema.stateChanges)
        .where(
          and(
            eq(schema.stateChanges.sessionId, sessionId),
            eq(schema.stateChanges.tableName, tableName),
            eq(schema.stateChanges.fieldName, fieldName),
          ),
        )
        .all();
      return rows.map(toStateChangeRecord);
    },
  };
}
