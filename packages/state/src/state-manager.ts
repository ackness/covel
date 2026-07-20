/**
 * State manager backed by DataStore for persistence.
 *
 * @deprecated Legacy path with no production callers. Nothing registers a
 * state table any more — gameplay state lives in plugin-data, characters, and
 * working memory, all of which go through the proposal/commit pipeline. Only
 * `GET /api/sessions/:id/state` still reads through it, and that read is
 * always empty in practice.
 *
 * It is kept (rather than deleted) so an existing database with legacy
 * `state_schemas` / `state_entries` rows can still be inspected. Do not build
 * on it: its multi-step writes (`upsertStateEntry` + `addStateChange`) are
 * NOT wrapped in a transaction, so a failure between them leaves an entry
 * without its change record. If a future feature needs registered state
 * tables, give it transactional writes first.
 */

import type { StateTableSchema, StateChangeEntry } from "@covel/shared";
import type {
  DataStore,
  StateSchemaRecord,
  StateEntryRecord,
  StateChangeRecord,
} from "@covel/store";

export interface StateChangeMetadata {
  readonly changedBy: string;
  readonly turnId: string;
  readonly reason?: string;
}

export interface StateManager {
  createTable(sessionId: string, schema: StateTableSchema): Promise<void>;
  getTableSchemas(sessionId: string): Promise<readonly StateTableSchema[]>;
  dropTable(sessionId: string, tableName: string): Promise<void>;

  getTableSnapshot(
    sessionId: string,
    table: string,
  ): Promise<Readonly<Record<string, unknown>>>;
  setValue(
    sessionId: string,
    table: string,
    field: string,
    value: unknown,
    metadata: StateChangeMetadata,
  ): Promise<void>;

  getChangeLog(
    sessionId: string,
    table: string,
    field: string,
  ): Promise<readonly StateChangeEntry[]>;
}

export function createStateManager(store: DataStore): StateManager {
  return {
    async createTable(sessionId, schema) {
      const schemaRecord: StateSchemaRecord = {
        id: crypto.randomUUID(),
        sessionId,
        tableName: schema.name,
        schema: schema,
        createdAt: new Date().toISOString(),
      };
      await store.saveStateSchema(schemaRecord);

      for (const fieldDef of schema.fields) {
        const defaultValue = fieldDef.default;
        const now = new Date().toISOString();

        const entryRecord: StateEntryRecord = {
          id: crypto.randomUUID(),
          sessionId,
          tableName: schema.name,
          fieldName: fieldDef.name,
          value: defaultValue,
          updatedAt: now,
        };
        await store.upsertStateEntry(entryRecord);

        // Persist the default value as a session-boundary change record
        if (defaultValue !== undefined) {
          const changeRecord: StateChangeRecord = {
            id: crypto.randomUUID(),
            sessionId,
            tableName: schema.name,
            fieldName: fieldDef.name,
            value: defaultValue,
            changedBy: "system",
            turnId: "__init__",
            reason: "default",
            createdAt: now,
          };
          await store.addStateChange(changeRecord);
        }
      }
    },

    async getTableSchemas(sessionId) {
      const records = await store.listStateSchemas(sessionId);
      return records.map((r) => r.schema as StateTableSchema);
    },

    async dropTable(sessionId, tableName) {
      await store.deleteStateSchema(sessionId, tableName);
    },

    async getTableSnapshot(sessionId, table) {
      const entries = await store.listStateEntries(sessionId, table);
      const result: Record<string, unknown> = {};
      for (const entry of entries) {
        result[entry.fieldName] = entry.value;
      }
      return result;
    },

    async setValue(sessionId, table, field, value, metadata) {
      const now = new Date().toISOString();

      const entryRecord: StateEntryRecord = {
        id: crypto.randomUUID(),
        sessionId,
        tableName: table,
        fieldName: field,
        value,
        updatedAt: now,
      };
      await store.upsertStateEntry(entryRecord);

      const changeRecord: StateChangeRecord = {
        id: crypto.randomUUID(),
        sessionId,
        tableName: table,
        fieldName: field,
        value,
        changedBy: metadata.changedBy,
        turnId: metadata.turnId,
        reason: metadata.reason,
        createdAt: now,
      };
      await store.addStateChange(changeRecord);
    },

    async getChangeLog(sessionId, table, field) {
      const allChanges = await store.listStateChanges(sessionId, table, field);

      // Session-boundary default records (turnId === '__init__') are not part
      // of the visible change log.
      return allChanges
        .filter((c) => c.turnId !== "__init__")
        .map((c) => ({
          value: c.value,
          changedBy: c.changedBy,
          turnId: c.turnId,
          reason: c.reason,
          timestamp: c.createdAt,
        }));
    },
  };
}
