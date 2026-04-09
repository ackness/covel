/**
 * State manager backed by DataStore for persistence.
 */

import type { StateTableSchema, StateChangeEntry } from '@covel/shared';
import type { DataStore, StateSchemaRecord, StateEntryRecord, StateChangeRecord } from '@covel/store';

export interface StateChangeMetadata {
  readonly changedBy: string;
  readonly turnId: string;
  readonly reason?: string;
}

export interface StateHistoryConfig {
  readonly windowSize: number;
  readonly keepSessionBoundary: boolean;
}

export interface StateManager {
  createTable(sessionId: string, schema: StateTableSchema): Promise<void>;
  getTableSchemas(sessionId: string): Promise<readonly StateTableSchema[]>;
  dropTable(sessionId: string, tableName: string): Promise<void>;

  getValue(sessionId: string, table: string, field: string): Promise<unknown>;
  getTableSnapshot(sessionId: string, table: string): Promise<Readonly<Record<string, unknown>>>;
  setValue(sessionId: string, table: string, field: string, value: unknown, metadata: StateChangeMetadata): Promise<void>;

  getChangeLog(sessionId: string, table: string, field: string): Promise<readonly StateChangeEntry[]>;
  getChangesByTurn(sessionId: string, turnId: string): Promise<readonly StateChangeEntry[]>;
}

const DEFAULT_CONFIG: StateHistoryConfig = {
  windowSize: Infinity,
  keepSessionBoundary: false,
};

export function createStateManager(store: DataStore, config?: Partial<StateHistoryConfig>): StateManager {
  const resolved: StateHistoryConfig = { ...DEFAULT_CONFIG, ...config };

  /**
   * Apply sliding window to a change log array (in-memory trim before returning).
   * When keepSessionBoundary is true, the first entry (session boundary / default)
   * is preserved outside the window.
   */
  function applyWindow(
    entries: StateChangeEntry[],
    sessionBoundary: StateChangeEntry | undefined,
  ): readonly StateChangeEntry[] {
    if (!Number.isFinite(resolved.windowSize)) {
      // No window limit: include boundary only if keepSessionBoundary
      if (resolved.keepSessionBoundary && sessionBoundary) {
        return [sessionBoundary, ...entries];
      }
      return entries;
    }

    const trimmed = entries.length > resolved.windowSize
      ? entries.slice(entries.length - resolved.windowSize)
      : entries;

    if (resolved.keepSessionBoundary && sessionBoundary) {
      return [sessionBoundary, ...trimmed];
    }
    return trimmed;
  }

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
            changedBy: 'system',
            turnId: '__init__',
            reason: 'default',
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

    async getValue(sessionId, table, field) {
      const entry = await store.getStateEntry(sessionId, table, field);
      if (!entry) return undefined;
      return entry.value;
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

      // Separate session boundary (turnId === '__init__') from regular changes
      const sessionBoundary = allChanges.find((c) => c.turnId === '__init__');
      const regularChanges: StateChangeEntry[] = allChanges
        .filter((c) => c.turnId !== '__init__')
        .map((c) => ({
          value: c.value,
          changedBy: c.changedBy,
          turnId: c.turnId,
          reason: c.reason,
          timestamp: c.createdAt,
        }));

      const boundaryEntry: StateChangeEntry | undefined = sessionBoundary
        ? {
            value: sessionBoundary.value,
            changedBy: sessionBoundary.changedBy,
            turnId: sessionBoundary.turnId,
            reason: sessionBoundary.reason,
            timestamp: sessionBoundary.createdAt,
          }
        : undefined;

      return applyWindow(regularChanges, boundaryEntry);
    },

    async getChangesByTurn(sessionId, turnId) {
      // List all schemas to discover all tables and fields
      const schemas = await store.listStateSchemas(sessionId);
      const results: StateChangeEntry[] = [];

      for (const schemaRecord of schemas) {
        const schema = schemaRecord.schema as StateTableSchema;
        for (const fieldDef of schema.fields) {
          const changes = await store.listStateChanges(sessionId, schema.name, fieldDef.name);
          for (const c of changes) {
            if (c.turnId === turnId) {
              results.push({
                value: c.value,
                changedBy: c.changedBy,
                turnId: c.turnId,
                reason: c.reason,
                timestamp: c.createdAt,
              });
            }
          }
        }
      }

      return results;
    },
  };
}
