/**
 * IndexedDB DataStore implementation using the `idb` library.
 * Used for browser-side storage (T1/T2 deployment tiers).
 */

import { openDB, type IDBPDatabase } from 'idb';
import type {
  DataStore,
  SessionRecord,
  TurnResultRecord,
  RuntimeResultRecord,
  ToolCallRecordRow,
  StateSchemaRecord,
  StateEntryRecord,
  StateChangeRecord,
  EventRecord,
  ApprovalRecord,
  MessageRecord,
  CharacterRecord,
  PluginConfigRecord,
  WorldRecord,
  TraceEventRecord,
  TurnMessageRecord,
  PlayerInputRecord,
} from '../types.js';

const DB_VERSION = 2;

async function initDb(dbName: string): Promise<IDBPDatabase> {
  return openDB(dbName, DB_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        db.createObjectStore('sessions', { keyPath: 'id' });

        const turnResults = db.createObjectStore('turnResults', { keyPath: 'id' });
        turnResults.createIndex('sessionId', 'sessionId');

        const runtimeResults = db.createObjectStore('runtimeResults', { keyPath: 'id' });
        runtimeResults.createIndex('sessionId_turnId', ['sessionId', 'turnId']);

        const toolCalls = db.createObjectStore('toolCalls', { keyPath: 'id' });
        toolCalls.createIndex('sessionId', 'sessionId');
        toolCalls.createIndex('sessionId_turnId', ['sessionId', 'turnId']);

        const stateSchemas = db.createObjectStore('stateSchemas', { keyPath: 'id' });
        stateSchemas.createIndex('sessionId', 'sessionId');

        const stateEntries = db.createObjectStore('stateEntries', { keyPath: 'id' });
        stateEntries.createIndex('sessionId', 'sessionId');
        stateEntries.createIndex('lookup', ['sessionId', 'tableName', 'fieldName']);

        const stateChanges = db.createObjectStore('stateChanges', { keyPath: 'id' });
        stateChanges.createIndex('sessionId', 'sessionId');

        const events = db.createObjectStore('events', { keyPath: 'id' });
        events.createIndex('sessionId', 'sessionId');

        const approvals = db.createObjectStore('approvals', { keyPath: 'id' });
        approvals.createIndex('sessionId', 'sessionId');

        const messages = db.createObjectStore('messages', { keyPath: 'id' });
        messages.createIndex('sessionId', 'sessionId');

        const characters = db.createObjectStore('characters', { keyPath: 'id' });
        characters.createIndex('sessionId', 'sessionId');

        const pluginConfigs = db.createObjectStore('pluginConfigs', { keyPath: 'id' });
        pluginConfigs.createIndex('lookup', ['sessionId', 'pluginId']);

        db.createObjectStore('worlds', { keyPath: 'id' });

        const traceEvents = db.createObjectStore('traceEvents', { keyPath: 'id' });
        traceEvents.createIndex('sessionId', 'sessionId');
      }

      if (oldVersion < 2) {
        const turnMsgs = db.createObjectStore('turnMessages', { keyPath: 'id' });
        turnMsgs.createIndex('sessionId', 'sessionId');

        const playerInputs = db.createObjectStore('playerInputs', { keyPath: 'id' });
        playerInputs.createIndex('sessionId', 'sessionId');
        playerInputs.createIndex('lookup', ['sessionId', 'formId']);
      }
    },
  });
}

export async function createIdbStore(dbName?: string): Promise<DataStore> {
  const db = await initDb(dbName ?? 'covel-store');

  const store: DataStore = {
    // ── Session ──

    async createSession(session: SessionRecord): Promise<void> {
      await db.put('sessions', structuredClone(session));
    },

    async getSession(id: string): Promise<SessionRecord | null> {
      return (await db.get('sessions', id)) ?? null;
    },

    async updateSession(id, patch): Promise<void> {
      const existing = await db.get('sessions', id);
      if (!existing) return;
      await db.put('sessions', { ...existing, ...patch });
    },

    async listSessions(): Promise<SessionRecord[]> {
      return db.getAll('sessions');
    },

    async deleteSession(id: string): Promise<void> {
      await db.delete('sessions', id);
    },

    // ── Turn Results ──

    async saveTurnResult(record: TurnResultRecord): Promise<void> {
      await db.put('turnResults', structuredClone(record));
    },

    async getTurnResult(sessionId: string, turnId: string): Promise<TurnResultRecord | null> {
      const all = await db.getAllFromIndex('turnResults', 'sessionId', sessionId);
      return all.find((r) => r.turnId === turnId) ?? null;
    },

    async listTurnResults(sessionId: string, limit?: number): Promise<TurnResultRecord[]> {
      const all = await db.getAllFromIndex('turnResults', 'sessionId', sessionId);
      const sorted = all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return limit !== undefined ? sorted.slice(0, limit) : sorted;
    },

    // ── Runtime Results ──

    async saveRuntimeResult(record: RuntimeResultRecord): Promise<void> {
      await db.put('runtimeResults', structuredClone(record));
    },

    async listRuntimeResults(sessionId: string, turnId: string): Promise<RuntimeResultRecord[]> {
      return db.getAllFromIndex('runtimeResults', 'sessionId_turnId', [sessionId, turnId]);
    },

    // ── Tool Calls ──

    async saveToolCall(record: ToolCallRecordRow): Promise<void> {
      await db.put('toolCalls', structuredClone(record));
    },

    async listToolCalls(sessionId: string, turnId?: string): Promise<ToolCallRecordRow[]> {
      if (turnId !== undefined) {
        return db.getAllFromIndex('toolCalls', 'sessionId_turnId', [sessionId, turnId]);
      }
      return db.getAllFromIndex('toolCalls', 'sessionId', sessionId);
    },

    // ── State Schemas ──

    async saveStateSchema(record: StateSchemaRecord): Promise<void> {
      await db.put('stateSchemas', structuredClone(record));
    },

    async listStateSchemas(sessionId: string): Promise<StateSchemaRecord[]> {
      return db.getAllFromIndex('stateSchemas', 'sessionId', sessionId);
    },

    async deleteStateSchema(sessionId: string, tableName: string): Promise<void> {
      const all = await db.getAllFromIndex('stateSchemas', 'sessionId', sessionId);
      const target = all.find((r) => r.tableName === tableName);
      if (target) {
        await db.delete('stateSchemas', target.id);
      }
    },

    // ── State Entries ──

    async getStateEntry(sessionId: string, tableName: string, fieldName: string): Promise<StateEntryRecord | null> {
      const results = await db.getAllFromIndex('stateEntries', 'lookup', [sessionId, tableName, fieldName]);
      return results[0] ?? null;
    },

    async upsertStateEntry(record: StateEntryRecord): Promise<void> {
      // Delete existing entry with same composite key, then insert the new one
      const existing = await db.getAllFromIndex('stateEntries', 'lookup', [record.sessionId, record.tableName, record.fieldName]);
      const tx = db.transaction('stateEntries', 'readwrite');
      for (const old of existing) {
        await tx.store.delete(old.id);
      }
      await tx.store.put(structuredClone(record));
      await tx.done;
    },

    async listStateEntries(sessionId: string, tableName: string): Promise<StateEntryRecord[]> {
      const all = await db.getAllFromIndex('stateEntries', 'sessionId', sessionId);
      return all.filter((r) => r.tableName === tableName);
    },

    // ── State Changes ──

    async addStateChange(record: StateChangeRecord): Promise<void> {
      await db.put('stateChanges', structuredClone(record));
    },

    async listStateChanges(sessionId: string, tableName: string, fieldName: string): Promise<StateChangeRecord[]> {
      const all = await db.getAllFromIndex('stateChanges', 'sessionId', sessionId);
      return all
        .filter((r) => r.tableName === tableName && r.fieldName === fieldName)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    // ── Events ──

    async saveEvent(record: EventRecord): Promise<void> {
      await db.put('events', structuredClone(record));
    },

    async listEvents(sessionId: string, options?: { topic?: string; limit?: number }): Promise<EventRecord[]> {
      let filtered = await db.getAllFromIndex('events', 'sessionId', sessionId);
      if (options?.topic !== undefined) {
        filtered = filtered.filter((r) => r.topic === options.topic);
      }
      if (options?.limit !== undefined) {
        filtered = filtered.slice(0, options.limit);
      }
      return filtered;
    },

    // ── Approvals ──

    async saveApproval(record: ApprovalRecord): Promise<void> {
      await db.put('approvals', structuredClone(record));
    },

    async listApprovals(sessionId: string): Promise<ApprovalRecord[]> {
      return db.getAllFromIndex('approvals', 'sessionId', sessionId);
    },

    // ── Messages ──

    async addMessage(record: MessageRecord): Promise<void> {
      await db.put('messages', structuredClone(record));
    },

    async listMessages(sessionId: string): Promise<MessageRecord[]> {
      const all = await db.getAllFromIndex('messages', 'sessionId', sessionId);
      return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    // ── Characters ──

    async upsertCharacter(record: CharacterRecord): Promise<void> {
      await db.put('characters', structuredClone(record));
    },

    async listCharacters(sessionId: string): Promise<CharacterRecord[]> {
      return db.getAllFromIndex('characters', 'sessionId', sessionId);
    },

    // ── Plugin Configs ──

    async savePluginConfig(record: PluginConfigRecord): Promise<void> {
      // Delete existing config with same composite key, then insert
      const existing = await db.getAllFromIndex('pluginConfigs', 'lookup', [record.sessionId, record.pluginId]);
      const tx = db.transaction('pluginConfigs', 'readwrite');
      for (const old of existing) {
        await tx.store.delete(old.id);
      }
      await tx.store.put(structuredClone(record));
      await tx.done;
    },

    async getPluginConfig(sessionId: string, pluginId: string): Promise<PluginConfigRecord | null> {
      const results = await db.getAllFromIndex('pluginConfigs', 'lookup', [sessionId, pluginId]);
      return results[0] ?? null;
    },

    // ── Worlds ──

    async listWorlds(): Promise<WorldRecord[]> {
      return db.getAll('worlds');
    },

    async getWorld(id: string): Promise<WorldRecord | null> {
      return (await db.get('worlds', id)) ?? null;
    },

    async upsertWorld(record: WorldRecord): Promise<void> {
      await db.put('worlds', structuredClone(record));
    },

    // ── Trace ──

    async addTraceEvent(record: TraceEventRecord): Promise<void> {
      await db.put('traceEvents', structuredClone(record));
    },

    async listTraceEvents(sessionId: string): Promise<TraceEventRecord[]> {
      return db.getAllFromIndex('traceEvents', 'sessionId', sessionId);
    },

    // ── Turn Messages ──

    async appendTurnMessage(record: TurnMessageRecord): Promise<void> {
      await db.put('turnMessages', structuredClone(record));
    },

    async listTurnMessages(sessionId: string): Promise<TurnMessageRecord[]> {
      const all = await db.getAllFromIndex('turnMessages', 'sessionId', sessionId);
      return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    // ── Player Inputs ──

    async savePlayerInput(record: PlayerInputRecord): Promise<void> {
      await db.put('playerInputs', structuredClone(record));
    },

    async getPlayerInput(sessionId: string, formId: string): Promise<PlayerInputRecord | null> {
      const results = await db.getAllFromIndex('playerInputs', 'lookup', [sessionId, formId]);
      return results[0] ?? null;
    },

    async listPlayerInputs(sessionId: string): Promise<PlayerInputRecord[]> {
      return db.getAllFromIndex('playerInputs', 'sessionId', sessionId);
    },

    // ── Lifecycle ──

    async close(): Promise<void> {
      db.close();
    },
  };

  return store;
}
