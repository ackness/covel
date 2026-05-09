import { and, asc, eq } from "drizzle-orm";

import type {
  DataStore,
  StateChangeRecord,
  StateEntryRecord,
  StateSchemaRecord,
} from "../types.js";
import type { PgDb } from "./pg-db.js";
import {
  toStateChangeRecord,
  toStateEntryRecord,
  toStateSchemaRecord,
} from "./pg-store-mappers.js";
import { pgStateEntryInsert, pgStateEntryUpdate } from "./pg-store-values.js";
import * as schema from "./schema.js";

export type PgStateRecords = Pick<
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

export function createPgStateRecords(getDb: () => PgDb): PgStateRecords {
  return {
    async saveStateSchema(record: StateSchemaRecord): Promise<void> {
      await getDb()
        .insert(schema.stateSchemas)
        .values({
          id: record.id,
          sessionId: record.sessionId,
          tableName: record.tableName,
          schema: record.schema ?? null,
          createdAt: record.createdAt,
        })
        .onConflictDoUpdate({
          target: schema.stateSchemas.id,
          set: {
            schema: record.schema ?? null,
          },
        });
    },

    async listStateSchemas(sessionId: string): Promise<StateSchemaRecord[]> {
      const rows = await getDb()
        .select()
        .from(schema.stateSchemas)
        .where(eq(schema.stateSchemas.sessionId, sessionId));
      return rows.map(toStateSchemaRecord);
    },

    async deleteStateSchema(
      sessionId: string,
      tableName: string,
    ): Promise<void> {
      await getDb()
        .delete(schema.stateSchemas)
        .where(
          and(
            eq(schema.stateSchemas.sessionId, sessionId),
            eq(schema.stateSchemas.tableName, tableName),
          ),
        );
    },

    async getStateEntry(
      sessionId: string,
      tableName: string,
      fieldName: string,
    ): Promise<StateEntryRecord | null> {
      const rows = await getDb()
        .select()
        .from(schema.stateEntries)
        .where(
          and(
            eq(schema.stateEntries.sessionId, sessionId),
            eq(schema.stateEntries.tableName, tableName),
            eq(schema.stateEntries.fieldName, fieldName),
          ),
        );
      return rows.length > 0 ? toStateEntryRecord(rows[0]) : null;
    },

    async upsertStateEntry(record: StateEntryRecord): Promise<void> {
      await getDb()
        .insert(schema.stateEntries)
        .values(pgStateEntryInsert(record))
        .onConflictDoUpdate({
          target: [
            schema.stateEntries.sessionId,
            schema.stateEntries.tableName,
            schema.stateEntries.fieldName,
          ],
          set: pgStateEntryUpdate(record),
        });
    },

    async listStateEntries(
      sessionId: string,
      tableName: string,
    ): Promise<StateEntryRecord[]> {
      const rows = await getDb()
        .select()
        .from(schema.stateEntries)
        .where(
          and(
            eq(schema.stateEntries.sessionId, sessionId),
            eq(schema.stateEntries.tableName, tableName),
          ),
        );
      return rows.map(toStateEntryRecord);
    },

    async addStateChange(record: StateChangeRecord): Promise<void> {
      await getDb()
        .insert(schema.stateChanges)
        .values({
          id: record.id,
          sessionId: record.sessionId,
          tableName: record.tableName,
          fieldName: record.fieldName,
          value: record.value ?? null,
          changedBy: record.changedBy,
          turnId: record.turnId,
          reason: record.reason ?? null,
          createdAt: record.createdAt,
        });
    },

    async listStateChanges(
      sessionId: string,
      tableName: string,
      fieldName: string,
    ): Promise<StateChangeRecord[]> {
      const rows = await getDb()
        .select()
        .from(schema.stateChanges)
        .where(
          and(
            eq(schema.stateChanges.sessionId, sessionId),
            eq(schema.stateChanges.tableName, tableName),
            eq(schema.stateChanges.fieldName, fieldName),
          ),
        )
        .orderBy(asc(schema.stateChanges.createdAt));
      return rows.map(toStateChangeRecord);
    },
  };
}
