/**
 * IndexedDB DataStore implementation using the `idb` library.
 *
 * Used by the web frontend's `local` storage mode (offline / no-server
 * scenarios). The default mode is `remote` (server-side SQLite/PG via the
 * HTTP API); IDB only kicks in when the user explicitly opts into local
 * mode from the frontend's data-service layer.
 */

import { openDB, type IDBPDatabase } from 'idb';
export { createIndexedDbMediaStore } from './idb-media-store.js';
export type { IndexedDbMediaStoreOptions } from './idb-media-store.js';

function applyPagination<T>(items: T[], pagination?: PaginationOpts): T[] {
  if (!pagination) return items;
  const offset = pagination.offset ?? 0;
  const limit = pagination.limit;
  if (limit !== undefined) return items.slice(offset, offset + limit);
  if (offset > 0) return items.slice(offset);
  return items;
}
import type {
  DataStore,
  PaginationOpts,
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
  PluginDataRecord,
  PluginConfigRecord,
  WorldRecord,
  TraceEventRecord,
  RuntimeOutputRecord,
  InteractionRecordRow,
  RuntimeOutputFilters,
  InteractionRecordFilters,
  TurnMessageRecord,
  PlayerInputRecord,
  WorkingMemoryRecord,
  LorebookEntryRecord,
  SessionSummaryRecord,
  SuspensionRecord,
  SnapshotRecord,
} from '../types.js';

const DB_VERSION = 8;

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

      if (oldVersion < 3) {
        const pluginData = db.createObjectStore('plugin_data', { keyPath: 'id' });
        pluginData.createIndex('sessionId_pluginId', ['sessionId', 'pluginId']);
        pluginData.createIndex('lookup', ['sessionId', 'pluginId', 'namespace', 'key']);
      }

      if (oldVersion < 4) {
        const workingMemory = db.createObjectStore('working_memory', { keyPath: 'id' });
        workingMemory.createIndex('sessionId', 'sessionId');
        workingMemory.createIndex('scopeKeyLookup', ['sessionId', 'scope', 'key']);

        const summaries = db.createObjectStore('sessionSummaries', { keyPath: 'id' });
        summaries.createIndex('sessionId', 'sessionId');

        const suspensions = db.createObjectStore('suspensions', { keyPath: 'id' });
        suspensions.createIndex('sessionId', 'sessionId');
      }

      if (oldVersion < 5) {
        const snapshots = db.createObjectStore('state_snapshots', { keyPath: 'id' });
        snapshots.createIndex('sessionId', 'sessionId');
      }

      if (oldVersion < 6) {
        const lorebookEntries = db.createObjectStore('lorebook_entries', { keyPath: 'id' });
        lorebookEntries.createIndex('sessionId', 'sessionId');
      }

      if (oldVersion < 7) {
        // PR-1 translation layer: runtime_outputs + interaction_records
        const runtimeOutputs = db.createObjectStore('runtime_outputs', { keyPath: 'id' });
        runtimeOutputs.createIndex('sessionId', 'sessionId');
        runtimeOutputs.createIndex('session_time', ['sessionId', 'timestamp']);
        runtimeOutputs.createIndex('session_runtime', ['sessionId', 'runtimeId']);

        const interactionRecords = db.createObjectStore('interaction_records', { keyPath: 'id' });
        interactionRecords.createIndex('sessionId', 'sessionId');
        interactionRecords.createIndex('session_time', ['sessionId', 'timestamp']);
        interactionRecords.createIndex('session_type', ['sessionId', 'type']);
      }

      if (oldVersion < 8) {
        // SessionRecord schema migration: phase/playingTurnOffset → status/preGameCompleted.
        // IDB cannot ALTER columns; drop-and-recreate is acceptable because
        // T1/T2 IdbStore is dev/test only.
        if (db.objectStoreNames.contains('sessions')) {
          db.deleteObjectStore('sessions');
        }
        db.createObjectStore('sessions', { keyPath: 'id' });
      }
    },
  });
}

// All IndexedDB object stores the backend owns. Used by the tx snapshot machinery.
const OBJECT_STORES = [
  'sessions',
  'turnResults',
  'runtimeResults',
  'toolCalls',
  'stateSchemas',
  'stateEntries',
  'stateChanges',
  'events',
  'approvals',
  'messages',
  'characters',
  'pluginConfigs',
  'worlds',
  'traceEvents',
  'turnMessages',
  'playerInputs',
  'plugin_data',
  'working_memory',
  'lorebook_entries',
  'sessionSummaries',
  'suspensions',
  'state_snapshots',
  'runtime_outputs',
  'interaction_records',
] as const;

type StoreName = (typeof OBJECT_STORES)[number];

export async function createIdbStore(dbName?: string): Promise<DataStore> {
  const db = await initDb(dbName ?? 'covel-store');

  // ── Transaction snapshot state (S4-T1, Finding 3 fix) ──
  //
  // IndexedDB object-store-level transactions are scoped to the stores named at
  // tx creation, which does not fit the "one transaction per commit pipeline"
  // model. Rather than eagerly snapshotting every object store on beginTx (which
  // would clobber concurrent out-of-band writes from other tabs / SSE / interval
  // jobs on rollback), we track only the stores actually mutated during the tx
  // and snapshot them lazily on first touch. Rollback clears + refills only the
  // touched stores, leaving everything else untouched.
  let idbSnapshot: Map<string, unknown[]> | null = null;
  let touchedStores: Set<string> | null = null;

  /**
   * First-touch snapshot: records a store's current rows the first time it is
   * mutated inside an active tx. Subsequent mutations to the same store hit the
   * membership check and return fast.
   */
  async function ensureStoreSnapshot(name: StoreName): Promise<void> {
    if (!touchedStores || !idbSnapshot) return; // no tx active
    if (touchedStores.has(name)) return; // already snapshotted
    touchedStores.add(name);
    const rows = await db.getAll(name);
    idbSnapshot.set(name, structuredClone(rows));
  }

  async function putAndTrack(name: StoreName, value: unknown): Promise<void> {
    await ensureStoreSnapshot(name);
    await db.put(name, value as Record<string, unknown>);
  }

  async function deleteAndTrack(name: StoreName, key: unknown): Promise<void> {
    await ensureStoreSnapshot(name);
    await db.delete(name, key as IDBValidKey);
  }

  async function restoreTouchedStores(
    names: Set<string>,
    snap: Map<string, unknown[]>,
  ): Promise<void> {
    for (const name of names) {
      const tx = db.transaction(name as StoreName, 'readwrite');
      await tx.store.clear();
      const rows = snap.get(name) ?? [];
      for (const row of rows) {
        await tx.store.put(row as Record<string, unknown>);
      }
      await tx.done;
    }
  }

  const store: DataStore = {
    // ── Session ──

    async createSession(session: SessionRecord): Promise<void> {
      await putAndTrack('sessions', structuredClone(session));
    },

    async getSession(id: string): Promise<SessionRecord | null> {
      return (await db.get('sessions', id)) ?? null;
    },

    async updateSession(id, patch): Promise<void> {
      const existing = await db.get('sessions', id);
      if (!existing) return;
      await putAndTrack('sessions', { ...existing, ...patch });
    },

    async listSessions(): Promise<SessionRecord[]> {
      return db.getAll('sessions');
    },

    async deleteSession(id: string): Promise<void> {
      // Cascade delete all session-scoped child rows. IndexedDB does not
      // provide schema-level ON DELETE CASCADE, so we must do this manually —
      // mirrors the SQLite / PG backends. Use deleteAndTrack so an active tx
      // can still roll back the cascade.
      //
      // For stores with a single-column `sessionId` index, fetch matching
      // rows via the index. For stores that only expose composite indexes
      // whose first field is sessionId (runtimeResults → `sessionId_turnId`,
      // pluginConfigs → `lookup`, plugin_data → `lookup`), a full getAll +
      // filter is simpler than a cursor range query and has the same
      // asymptotic cost at T1/T2 volumes. Adding a plain `sessionId` index
      // to those stores would require a schema-version bump and a migration.
      const cascadeByIndex = async (storeName: StoreName): Promise<void> => {
        const rows = (await db.getAllFromIndex(storeName, 'sessionId', id)) as Array<{
          id: string;
        }>;
        for (const row of rows) {
          await deleteAndTrack(storeName, row.id);
        }
      };
      const cascadeByFilter = async (storeName: StoreName): Promise<void> => {
        const all = (await db.getAll(storeName)) as Array<{ id: string; sessionId: string }>;
        for (const row of all) {
          if (row.sessionId === id) await deleteAndTrack(storeName, row.id);
        }
      };
      await cascadeByIndex('turnResults');
      await cascadeByFilter('runtimeResults');
      await cascadeByIndex('toolCalls');
      await cascadeByIndex('stateSchemas');
      await cascadeByIndex('stateEntries');
      await cascadeByIndex('stateChanges');
      await cascadeByIndex('events');
      await cascadeByIndex('approvals');
      await cascadeByIndex('messages');
      await cascadeByIndex('characters');
      await cascadeByIndex('traceEvents');
      await cascadeByIndex('turnMessages');
      await cascadeByIndex('playerInputs');
      await cascadeByIndex('working_memory');
      await cascadeByIndex('sessionSummaries');
      await cascadeByIndex('suspensions');
      await cascadeByIndex('state_snapshots');
      await cascadeByIndex('lorebook_entries');
      await cascadeByIndex('runtime_outputs');
      await cascadeByIndex('interaction_records');
      // pluginConfigs and plugin_data have composite indexes; full-scan filter.
      await cascadeByFilter('pluginConfigs');
      await cascadeByFilter('plugin_data');
      await deleteAndTrack('sessions', id);
    },

    // ── Turn Results ──

    async saveTurnResult(record: TurnResultRecord): Promise<void> {
      await putAndTrack('turnResults', structuredClone(record));
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
      await putAndTrack('runtimeResults', structuredClone(record));
    },

    async listRuntimeResults(sessionId: string, turnId: string): Promise<RuntimeResultRecord[]> {
      return db.getAllFromIndex('runtimeResults', 'sessionId_turnId', [sessionId, turnId]);
    },

    // ── Tool Calls ──

    async saveToolCall(record: ToolCallRecordRow): Promise<void> {
      await putAndTrack('toolCalls', structuredClone(record));
    },

    async listToolCalls(sessionId: string, turnId?: string): Promise<ToolCallRecordRow[]> {
      if (turnId !== undefined) {
        return db.getAllFromIndex('toolCalls', 'sessionId_turnId', [sessionId, turnId]);
      }
      return db.getAllFromIndex('toolCalls', 'sessionId', sessionId);
    },

    // ── State Schemas ──

    async saveStateSchema(record: StateSchemaRecord): Promise<void> {
      await putAndTrack('stateSchemas', structuredClone(record));
    },

    async listStateSchemas(sessionId: string): Promise<StateSchemaRecord[]> {
      return db.getAllFromIndex('stateSchemas', 'sessionId', sessionId);
    },

    async deleteStateSchema(sessionId: string, tableName: string): Promise<void> {
      const all = await db.getAllFromIndex('stateSchemas', 'sessionId', sessionId);
      const target = all.find((r) => r.tableName === tableName);
      if (target) {
        await deleteAndTrack('stateSchemas', target.id);
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
      await ensureStoreSnapshot('stateEntries');
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
      await putAndTrack('stateChanges', structuredClone(record));
    },

    async listStateChanges(sessionId: string, tableName: string, fieldName: string): Promise<StateChangeRecord[]> {
      const all = await db.getAllFromIndex('stateChanges', 'sessionId', sessionId);
      return all
        .filter((r) => r.tableName === tableName && r.fieldName === fieldName)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    // ── Events ──

    async saveEvent(record: EventRecord): Promise<void> {
      await putAndTrack('events', structuredClone(record));
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
      await putAndTrack('approvals', structuredClone(record));
    },

    async listApprovals(sessionId: string): Promise<ApprovalRecord[]> {
      return db.getAllFromIndex('approvals', 'sessionId', sessionId);
    },

    // ── Messages ──

    async addMessage(record: MessageRecord): Promise<void> {
      await putAndTrack('messages', structuredClone(record));
    },

    async listMessages(sessionId: string, pagination?: PaginationOpts): Promise<MessageRecord[]> {
      const all = await db.getAllFromIndex('messages', 'sessionId', sessionId);
      const sorted = all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return applyPagination(sorted, pagination);
    },

    // ── Characters ──

    async upsertCharacter(record: CharacterRecord): Promise<void> {
      await putAndTrack('characters', structuredClone(record));
    },

    async listCharacters(sessionId: string): Promise<CharacterRecord[]> {
      return db.getAllFromIndex('characters', 'sessionId', sessionId);
    },

    // ── Plugin Data ──

    async setPluginData(record: PluginDataRecord): Promise<void> {
      // Delete any existing record with the same composite key, then insert the new one
      await ensureStoreSnapshot('plugin_data');
      const tx = db.transaction('plugin_data', 'readwrite');
      const existing = await tx.store.index('lookup').get([record.sessionId, record.pluginId, record.namespace, record.key]);
      if (existing) {
        await tx.store.delete(existing.id);
      }
      await tx.store.put(structuredClone(record));
      await tx.done;
    },

    async setPluginDataBatch(records: readonly PluginDataRecord[]): Promise<void> {
      if (records.length === 0) return;
      await ensureStoreSnapshot('plugin_data');
      const tx = db.transaction('plugin_data', 'readwrite');
      for (const record of records) {
        const existing = await tx.store.index('lookup').get([record.sessionId, record.pluginId, record.namespace, record.key]);
        if (existing) {
          await tx.store.delete(existing.id);
        }
        await tx.store.put(structuredClone(record));
      }
      await tx.done;
    },

    async getPluginData(sessionId: string, pluginId: string, namespace: string, key: string): Promise<PluginDataRecord | null> {
      const results = await db.getAllFromIndex('plugin_data', 'lookup', [sessionId, pluginId, namespace, key]);
      return results[0] ?? null;
    },

    async listPluginData(sessionId: string, pluginId: string, namespace?: string, pagination?: PaginationOpts): Promise<PluginDataRecord[]> {
      const all = await db.getAllFromIndex('plugin_data', 'sessionId_pluginId', [sessionId, pluginId]);
      const filtered = namespace === undefined ? all : all.filter((r) => r.namespace === namespace);
      return applyPagination(filtered, pagination);
    },

    async listPluginDataSessionScope(sessionId: string): Promise<readonly PluginDataRecord[]> {
      // IDB is dev/test-only and its `plugin_data` store has no (sessionId)-only
      // composite index. Full scan + in-memory filter is acceptable at this
      // scale (per audit 2026-04-20 finding 7.2).
      const all = (await db.getAll('plugin_data')) as PluginDataRecord[];
      return all.filter((r) => r.sessionId === sessionId);
    },

    async deletePluginData(sessionId: string, pluginId: string, namespace: string, key: string): Promise<void> {
      const existing = await db.getAllFromIndex('plugin_data', 'lookup', [sessionId, pluginId, namespace, key]);
      for (const record of existing) {
        await deleteAndTrack('plugin_data', record.id);
      }
    },

    // ── Plugin Configs ──

    async savePluginConfig(record: PluginConfigRecord): Promise<void> {
      // Delete existing config with same composite key, then insert
      const existing = await db.getAllFromIndex('pluginConfigs', 'lookup', [record.sessionId, record.pluginId]);
      await ensureStoreSnapshot('pluginConfigs');
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
      await putAndTrack('worlds', structuredClone(record));
    },

    async deleteWorld(id: string): Promise<void> {
      await db.delete('worlds', id);
    },

    // ── Trace ──

    async addTraceEvent(record: TraceEventRecord): Promise<void> {
      await putAndTrack('traceEvents', structuredClone(record));
    },

    async listTraceEvents(sessionId: string, pagination?: PaginationOpts): Promise<TraceEventRecord[]> {
      const all = await db.getAllFromIndex('traceEvents', 'sessionId', sessionId);
      return applyPagination(all, pagination);
    },

    // ── Runtime Outputs (PR-1) ──

    async saveRuntimeOutput(record: RuntimeOutputRecord): Promise<void> {
      await putAndTrack('runtime_outputs', structuredClone(record));
    },

    async getRuntimeOutput(sessionId: string, id: string): Promise<RuntimeOutputRecord | null> {
      const row = (await db.get('runtime_outputs', id)) as RuntimeOutputRecord | undefined;
      if (!row || row.sessionId !== sessionId) return null;
      return row;
    },

    async listRuntimeOutputs(
      sessionId: string,
      filters?: RuntimeOutputFilters,
    ): Promise<RuntimeOutputRecord[]> {
      let rows = (await db.getAllFromIndex(
        'runtime_outputs',
        'sessionId',
        sessionId,
      )) as RuntimeOutputRecord[];
      if (filters?.runtimeId) {
        rows = rows.filter((r) => r.runtimeId === filters.runtimeId);
      }
      if (filters?.pluginId) {
        rows = rows.filter((r) => r.pluginId === filters.pluginId);
      }
      if (filters?.sinceTimestamp) {
        rows = rows.filter((r) => r.timestamp >= filters.sinceTimestamp!);
      }
      rows.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      if (filters?.limit !== undefined) {
        rows = rows.slice(0, filters.limit);
      }
      return rows;
    },

    // ── Interaction Records (PR-1) ──

    async saveInteractionRecord(record: InteractionRecordRow): Promise<void> {
      await putAndTrack('interaction_records', structuredClone(record));
    },

    async listInteractionRecords(
      sessionId: string,
      filters?: InteractionRecordFilters,
    ): Promise<InteractionRecordRow[]> {
      let rows = (await db.getAllFromIndex(
        'interaction_records',
        'sessionId',
        sessionId,
      )) as InteractionRecordRow[];
      if (filters?.type) {
        rows = rows.filter((r) => r.type === filters.type);
      }
      if (filters?.source) {
        rows = rows.filter((r) => r.source === filters.source);
      }
      if (filters?.targetPluginId) {
        rows = rows.filter((r) => r.targetPluginId === filters.targetPluginId);
      }
      rows.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      if (filters?.limit !== undefined) {
        rows = rows.slice(0, filters.limit);
      }
      return rows;
    },

    // ── Turn Messages ──

    async appendTurnMessage(record: TurnMessageRecord): Promise<void> {
      await putAndTrack('turnMessages', structuredClone(record));
    },

    async listTurnMessages(sessionId: string, pagination?: PaginationOpts): Promise<TurnMessageRecord[]> {
      const all = await db.getAllFromIndex('turnMessages', 'sessionId', sessionId);
      const sorted = all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return applyPagination(sorted, pagination);
    },

    // ── Player Inputs ──

    async savePlayerInput(record: PlayerInputRecord): Promise<void> {
      await putAndTrack('playerInputs', structuredClone(record));
    },

    async getPlayerInput(sessionId: string, formId: string): Promise<PlayerInputRecord | null> {
      const results = await db.getAllFromIndex('playerInputs', 'lookup', [sessionId, formId]);
      return results[0] ?? null;
    },

    async listPlayerInputs(sessionId: string): Promise<PlayerInputRecord[]> {
      return db.getAllFromIndex('playerInputs', 'sessionId', sessionId);
    },

    // ── Working Memory (S3-T3) ───────────────────────────────

    async upsertWorkingMemory(record: WorkingMemoryRecord): Promise<void> {
      // Find existing entry with same (sessionId, scope, key) to merge id handling
      const existing = await db.getFromIndex('working_memory', 'scopeKeyLookup', [
        record.sessionId,
        record.scope,
        record.key,
      ]);
      if (existing) {
        // Replace the record keeping the new id (spec: each upsert gets new UUID)
        await deleteAndTrack('working_memory', existing.id);
      }
      await putAndTrack('working_memory', structuredClone(record));
    },

    async getWorkingMemory(
      sessionId: string,
      scope: WorkingMemoryRecord['scope'],
      key: string,
    ): Promise<WorkingMemoryRecord | null> {
      const result = await db.getFromIndex('working_memory', 'scopeKeyLookup', [
        sessionId,
        scope,
        key,
      ]);
      return result ?? null;
    },

    async listWorkingMemory(sessionId: string): Promise<readonly WorkingMemoryRecord[]> {
      const entries = await db.getAllFromIndex('working_memory', 'sessionId', sessionId);
      // Sort: player → story → shared, then alphabetical key
      const scopeOrder: Record<string, number> = { player: 0, story: 1, shared: 2 };
      entries.sort((a, b) => {
        const scopeDiff = (scopeOrder[a.scope] ?? 99) - (scopeOrder[b.scope] ?? 99);
        if (scopeDiff !== 0) return scopeDiff;
        return a.key.localeCompare(b.key);
      });
      return entries;
    },

    async deleteWorkingMemory(
      sessionId: string,
      scope: WorkingMemoryRecord['scope'],
      key: string,
    ): Promise<void> {
      const existing = await db.getFromIndex('working_memory', 'scopeKeyLookup', [
        sessionId,
        scope,
        key,
      ]);
      if (existing) {
        await deleteAndTrack('working_memory', existing.id);
      }
    },

    // ── Lorebook Entries (S3-T2) ─────────────────────────────

    async upsertLorebookEntries(records: readonly LorebookEntryRecord[]): Promise<void> {
      if (records.length === 0) return;
      await ensureStoreSnapshot('lorebook_entries');
      const tx = db.transaction('lorebook_entries', 'readwrite');
      for (const record of records) {
        await tx.store.put(structuredClone(record));
      }
      await tx.done;
    },

    async listSessionLorebookEntries(
      sessionId: string,
    ): Promise<readonly LorebookEntryRecord[]> {
      const all = (await db.getAllFromIndex(
        'lorebook_entries',
        'sessionId',
        sessionId,
      )) as LorebookEntryRecord[];
      return all.slice().sort((a, b) => {
        if (a.insertionOrder !== b.insertionOrder) {
          return a.insertionOrder - b.insertionOrder;
        }
        return a.id.localeCompare(b.id);
      });
    },

    async deleteLorebookEntry(sessionId: string, id: string): Promise<void> {
      const existing = (await db.get('lorebook_entries', id)) as
        | LorebookEntryRecord
        | undefined;
      if (existing && existing.sessionId === sessionId) {
        await deleteAndTrack('lorebook_entries', id);
      }
    },

    // ── Session Summaries (S2-T2 Compactor) ──

    async saveSessionSummary(record: SessionSummaryRecord): Promise<void> {
      await putAndTrack('sessionSummaries', structuredClone(record));
    },

    async listSessionSummaries(sessionId: string): Promise<readonly SessionSummaryRecord[]> {
      return db.getAllFromIndex('sessionSummaries', 'sessionId', sessionId);
    },

    async deleteSessionSummaries(sessionId: string): Promise<void> {
      const all = await db.getAllFromIndex('sessionSummaries', 'sessionId', sessionId);
      for (const r of all) {
        await deleteAndTrack('sessionSummaries', (r as SessionSummaryRecord).id);
      }
    },

    async tagTurnMessagesCompacted(
      sessionId: string,
      messageIds: readonly string[],
      summaryId: string,
    ): Promise<void> {
      const idSet = new Set(messageIds);
      const all = await db.getAllFromIndex('turnMessages', 'sessionId', sessionId);
      for (const msg of all as TurnMessageRecord[]) {
        if (idSet.has(msg.id)) {
          await putAndTrack('turnMessages', structuredClone({ ...msg, compactedAtTurnId: summaryId }));
        }
      }
    },

    // ── Suspensions (S4-T4) ──

    async saveSuspension(record: SuspensionRecord): Promise<void> {
      await putAndTrack('suspensions', structuredClone(record));
    },

    async getSuspension(id: string): Promise<SuspensionRecord | null> {
      return (await db.get('suspensions', id)) ?? null;
    },

    async markSuspensionResolved(id: string): Promise<void> {
      const existing = await db.get('suspensions', id) as SuspensionRecord | undefined;
      if (!existing) return;
      await putAndTrack('suspensions', { ...existing, resolvedAt: new Date().toISOString() });
    },

    async claimSuspension(id: string): Promise<boolean> {
      // Atomic compare-and-swap: perform the get/check/put inside a single
      // IDB readwrite transaction so no concurrent call can observe an
      // unresolved row and both "win". Snapshot the store BEFORE the tx so a
      // surrounding beginTx/rollbackTx can still revert the claim.
      await ensureStoreSnapshot('suspensions');
      const tx = db.transaction('suspensions', 'readwrite');
      const existing = (await tx.store.get(id)) as SuspensionRecord | undefined;
      if (!existing || existing.resolvedAt) {
        await tx.done;
        return false;
      }
      await tx.store.put(structuredClone({
        ...existing,
        resolvedAt: `claimed:${new Date().toISOString()}`,
      }));
      await tx.done;
      return true;
    },

    async listSuspensions(sessionId: string): Promise<readonly SuspensionRecord[]> {
      const all = await db.getAllFromIndex('suspensions', 'sessionId', sessionId);
      return (all as SuspensionRecord[]).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    async deleteSuspension(id: string): Promise<void> {
      await deleteAndTrack('suspensions', id);
    },

    // ── Snapshots (S4-T2) ──

    async saveSnapshot(record: SnapshotRecord): Promise<void> {
      await putAndTrack('state_snapshots', structuredClone(record));
    },

    async getSnapshot(id: string): Promise<SnapshotRecord | null> {
      return ((await db.get('state_snapshots', id)) as SnapshotRecord | undefined) ?? null;
    },

    async listSnapshots(sessionId: string): Promise<readonly SnapshotRecord[]> {
      const all = await db.getAllFromIndex('state_snapshots', 'sessionId', sessionId);
      return (all as SnapshotRecord[]).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    async deleteSnapshot(id: string): Promise<void> {
      await deleteAndTrack('state_snapshots', id);
    },

    // ── Transactions (S4-T1) ──

    async beginTx(): Promise<void> {
      if (touchedStores !== null || idbSnapshot !== null) {
        throw new Error('IdbStore: nested transactions are not supported (beginTx called while another tx is active)');
      }
      // Lazy per-store snapshot: `touchedStores` tracks which object stores have
      // been mutated; `ensureStoreSnapshot` captures the original rows on first
      // touch so rollback can refill only those stores. Out-of-band writes to
      // other stores (from other tabs / SSE / interval jobs) survive rollback.
      touchedStores = new Set();
      idbSnapshot = new Map();
    },

    async commitTx(): Promise<void> {
      if (touchedStores === null || idbSnapshot === null) {
        throw new Error('IdbStore: commitTx called without an active transaction');
      }
      touchedStores = null;
      idbSnapshot = null;
    },

    async rollbackTx(): Promise<void> {
      if (touchedStores === null || idbSnapshot === null) {
        throw new Error('IdbStore: rollbackTx called without an active transaction');
      }
      // Clear the tx state in finally: if restoreTouchedStores throws mid-refill
      // the store is in a half-restored state, but the next beginTx must still
      // be able to proceed rather than see a stale "tx active" flag.
      const touched = touchedStores;
      const snapshot = idbSnapshot;
      touchedStores = null;
      idbSnapshot = null;
      await restoreTouchedStores(touched, snapshot);
    },

    // ── Lifecycle ──

    async close(): Promise<void> {
      db.close();
    },
  };

  return store;
}
