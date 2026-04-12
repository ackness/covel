/**
 * In-memory DataStore implementation.
 * Used for testing and ephemeral sessions.
 */

import type { PaginationOpts } from '../types.js';

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
  TurnMessageRecord,
  PlayerInputRecord,
} from '../types.js';
import type {
  VectorStoreCapability,
  UpsertVectorInput,
  SearchVectorsInput,
  VectorSearchResult,
  DeleteVectorsInput,
} from '../vector-store.js';

/** In-memory vector row. Mutable — this is only for dev/test. */
interface MemoryVectorRow {
  sessionId: string;
  pluginId: string;
  namespace: string;
  key: string;
  dimensions: number;
  embedding: Float32Array;
  payload: string | null;
}

function squaredL2(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return sum;
}

export function createMemoryStore(): DataStore & VectorStoreCapability {
  const sessions = new Map<string, SessionRecord>();
  const turnResults: TurnResultRecord[] = [];
  const runtimeResults: RuntimeResultRecord[] = [];
  const toolCalls: ToolCallRecordRow[] = [];
  const stateSchemas: StateSchemaRecord[] = [];
  const stateEntries = new Map<string, StateEntryRecord>();
  const stateChanges: StateChangeRecord[] = [];
  const events: EventRecord[] = [];
  const approvals: ApprovalRecord[] = [];
  const messages: MessageRecord[] = [];
  const characters = new Map<string, CharacterRecord>();
  const pluginData = new Map<string, PluginDataRecord>();
  const pluginConfigs = new Map<string, PluginConfigRecord>();
  /** Keyed by `${sessionId}:${pluginId}:${namespace}:${key}:${dim}` so
   *  multiple dims can coexist for the same logical row if a caller ever
   *  re-embeds with a different model. */
  const vectorRows = new Map<string, MemoryVectorRow>();
  const worlds = new Map<string, WorldRecord>();
  const traceEvents: TraceEventRecord[] = [];
  const turnMessages: TurnMessageRecord[] = [];
  const playerInputs: PlayerInputRecord[] = [];

  function stateEntryKey(sessionId: string, tableName: string, fieldName: string): string {
    return `${sessionId}:${tableName}:${fieldName}`;
  }

  function pluginDataKey(sessionId: string, pluginId: string, namespace: string, key: string): string {
    return `${sessionId}:${pluginId}:${namespace}:${key}`;
  }

  function pluginConfigKey(sessionId: string, pluginId: string): string {
    return `${sessionId}:${pluginId}`;
  }

  function vectorRowKey(
    sessionId: string,
    pluginId: string,
    namespace: string,
    key: string,
    dimensions: number,
  ): string {
    return `${sessionId}:${pluginId}:${namespace}:${key}:${dimensions}`;
  }

  const store: DataStore & VectorStoreCapability = {
    // ── Session ──

    async createSession(session) {
      sessions.set(session.id, session);
    },

    async getSession(id) {
      return sessions.get(id) ?? null;
    },

    async updateSession(id, patch) {
      const existing = sessions.get(id);
      if (!existing) return;
      sessions.set(id, { ...existing, ...patch });
    },

    async listSessions() {
      return [...sessions.values()];
    },

    async deleteSession(id) {
      sessions.delete(id);
      // Cascade delete all session-scoped data
      const filterArr = <T extends { sessionId: string }>(arr: T[]): void => {
        for (let i = arr.length - 1; i >= 0; i--) {
          if (arr[i].sessionId === id) arr.splice(i, 1);
        }
      };
      filterArr(turnResults);
      filterArr(runtimeResults);
      filterArr(toolCalls);
      filterArr(stateSchemas);
      filterArr(stateChanges);
      filterArr(events);
      filterArr(approvals);
      filterArr(messages);
      filterArr(traceEvents);
      filterArr(turnMessages);
      filterArr(playerInputs);
      for (const [k, v] of stateEntries) { if (v.sessionId === id) stateEntries.delete(k); }
      for (const [k, v] of characters) { if (v.sessionId === id) characters.delete(k); }
      for (const [k, v] of pluginData) { if (v.sessionId === id) pluginData.delete(k); }
      for (const [k, v] of pluginConfigs) { if (v.sessionId === id) pluginConfigs.delete(k); }
    },

    // ── Turn Results ──

    async saveTurnResult(record) {
      turnResults.push(record);
    },

    async getTurnResult(sessionId, turnId) {
      return (
        turnResults.find((r) => r.sessionId === sessionId && r.turnId === turnId) ?? null
      );
    },

    async listTurnResults(sessionId, limit?) {
      const filtered = turnResults
        .filter((r) => r.sessionId === sessionId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return limit !== undefined ? filtered.slice(0, limit) : filtered;
    },

    // ── Runtime Results ──

    async saveRuntimeResult(record) {
      runtimeResults.push(record);
    },

    async listRuntimeResults(sessionId, turnId) {
      return runtimeResults.filter(
        (r) => r.sessionId === sessionId && r.turnId === turnId,
      );
    },

    // ── Tool Calls ──

    async saveToolCall(record) {
      toolCalls.push(record);
    },

    async listToolCalls(sessionId, turnId?) {
      return toolCalls.filter(
        (r) => r.sessionId === sessionId && (turnId === undefined || r.turnId === turnId),
      );
    },

    // ── State Schemas ──

    async saveStateSchema(record) {
      stateSchemas.push(record);
    },

    async listStateSchemas(sessionId) {
      return stateSchemas.filter((r) => r.sessionId === sessionId);
    },

    async deleteStateSchema(sessionId, tableName) {
      const idx = stateSchemas.findIndex(
        (r) => r.sessionId === sessionId && r.tableName === tableName,
      );
      if (idx !== -1) stateSchemas.splice(idx, 1);
    },

    // ── State Entries ──

    async getStateEntry(sessionId, tableName, fieldName) {
      return stateEntries.get(stateEntryKey(sessionId, tableName, fieldName)) ?? null;
    },

    async upsertStateEntry(record) {
      stateEntries.set(
        stateEntryKey(record.sessionId, record.tableName, record.fieldName),
        record,
      );
    },

    async listStateEntries(sessionId, tableName) {
      return [...stateEntries.values()].filter(
        (r) => r.sessionId === sessionId && r.tableName === tableName,
      );
    },

    // ── State Changes ──

    async addStateChange(record) {
      stateChanges.push(record);
    },

    async listStateChanges(sessionId, tableName, fieldName) {
      return stateChanges
        .filter(
          (r) =>
            r.sessionId === sessionId &&
            r.tableName === tableName &&
            r.fieldName === fieldName,
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    // ── Events ──

    async saveEvent(record) {
      events.push(record);
    },

    async listEvents(sessionId, options?) {
      let filtered = events.filter((r) => r.sessionId === sessionId);
      if (options?.topic !== undefined) {
        filtered = filtered.filter((r) => r.topic === options.topic);
      }
      if (options?.limit !== undefined) {
        filtered = filtered.slice(0, options.limit);
      }
      return filtered;
    },

    // ── Approvals ──

    async saveApproval(record) {
      approvals.push(record);
    },

    async listApprovals(sessionId) {
      return approvals.filter((r) => r.sessionId === sessionId);
    },

    // ── Messages ──

    async addMessage(record) {
      messages.push(record);
    },

    async listMessages(sessionId, pagination?) {
      const filtered = messages
        .filter((r) => r.sessionId === sessionId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return applyPagination(filtered, pagination);
    },

    // ── Characters ──

    async upsertCharacter(record) {
      characters.set(record.id, record);
    },

    async listCharacters(sessionId) {
      return [...characters.values()].filter((r) => r.sessionId === sessionId);
    },

    // ── Plugin Data ──

    async setPluginData(record) {
      pluginData.set(pluginDataKey(record.sessionId, record.pluginId, record.namespace, record.key), record);
    },

    async setPluginDataBatch(records) {
      for (const record of records) {
        pluginData.set(pluginDataKey(record.sessionId, record.pluginId, record.namespace, record.key), record);
      }
    },

    async getPluginData(sessionId, pluginId, namespace, key) {
      return pluginData.get(pluginDataKey(sessionId, pluginId, namespace, key)) ?? null;
    },

    async listPluginData(sessionId, pluginId, namespace?, pagination?) {
      const filtered = [...pluginData.values()].filter(
        (r) =>
          r.sessionId === sessionId &&
          r.pluginId === pluginId &&
          (namespace === undefined || r.namespace === namespace),
      );
      return applyPagination(filtered, pagination);
    },

    async deletePluginData(sessionId, pluginId, namespace, key) {
      pluginData.delete(pluginDataKey(sessionId, pluginId, namespace, key));
    },

    // ── Plugin Configs ──

    async savePluginConfig(record) {
      pluginConfigs.set(pluginConfigKey(record.sessionId, record.pluginId), record);
    },

    async getPluginConfig(sessionId, pluginId) {
      return pluginConfigs.get(pluginConfigKey(sessionId, pluginId)) ?? null;
    },

    // ── Worlds ──

    async listWorlds() {
      return [...worlds.values()];
    },

    async getWorld(id) {
      return worlds.get(id) ?? null;
    },

    async upsertWorld(record) {
      worlds.set(record.id, record);
    },

    // ── Trace ──

    async addTraceEvent(record) {
      traceEvents.push(record);
    },

    async listTraceEvents(sessionId, pagination?) {
      const filtered = traceEvents.filter((r) => r.sessionId === sessionId);
      return applyPagination(filtered, pagination);
    },

    // ── Turn Messages ──

    async appendTurnMessage(record) {
      turnMessages.push(record);
    },

    async listTurnMessages(sessionId, pagination?) {
      const filtered = turnMessages
        .filter((r) => r.sessionId === sessionId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return applyPagination(filtered, pagination);
    },

    // ── Player Inputs ──

    async savePlayerInput(record) {
      playerInputs.push(record);
    },

    async getPlayerInput(sessionId, formId) {
      return playerInputs.find(
        (r) => r.sessionId === sessionId && r.formId === formId,
      ) ?? null;
    },

    async listPlayerInputs(sessionId) {
      return playerInputs.filter((r) => r.sessionId === sessionId);
    },

    // ── Vector Store (brute-force, O(n) — fine for tests and <1k rows) ──

    async upsertVector(input: UpsertVectorInput) {
      if (input.embedding.length !== input.dimensions) {
        throw new Error(
          `Memory vector upsert: embedding length ${input.embedding.length} does not match declared dimensions ${input.dimensions}`,
        );
      }
      const rowKey = vectorRowKey(
        input.sessionId,
        input.pluginId,
        input.namespace,
        input.key,
        input.dimensions,
      );
      // Copy the Float32Array to decouple from caller-owned buffers.
      vectorRows.set(rowKey, {
        sessionId: input.sessionId,
        pluginId: input.pluginId,
        namespace: input.namespace,
        key: input.key,
        dimensions: input.dimensions,
        embedding: new Float32Array(input.embedding),
        payload: input.payload ?? null,
      });
    },

    async searchVectors(input: SearchVectorsInput): Promise<VectorSearchResult[]> {
      if (input.query.length !== input.dimensions) {
        throw new Error(
          `Memory vector search: query length ${input.query.length} does not match declared dimensions ${input.dimensions}`,
        );
      }
      const scored: Array<{ row: MemoryVectorRow; distance: number }> = [];
      for (const row of vectorRows.values()) {
        if (row.sessionId !== input.sessionId) continue;
        if (row.dimensions !== input.dimensions) continue;
        if (input.pluginId !== undefined && row.pluginId !== input.pluginId) continue;
        if (input.namespace !== undefined && row.namespace !== input.namespace) continue;
        scored.push({ row, distance: squaredL2(input.query, row.embedding) });
      }
      scored.sort((a, b) => a.distance - b.distance);
      return scored.slice(0, Math.max(0, input.topK)).map(({ row, distance }) => ({
        sessionId: row.sessionId,
        pluginId: row.pluginId,
        namespace: row.namespace,
        key: row.key,
        distance,
        payload: row.payload,
      }));
    },

    async deleteVectors(input: DeleteVectorsInput) {
      for (const [rowKey, row] of Array.from(vectorRows.entries())) {
        if (row.sessionId !== input.sessionId) continue;
        if (row.pluginId !== input.pluginId) continue;
        if (input.namespace !== undefined && row.namespace !== input.namespace) continue;
        if (input.dimensions !== undefined && row.dimensions !== input.dimensions) continue;
        vectorRows.delete(rowKey);
      }
    },

    // ── Lifecycle ──

    async close() {
      // No-op for in-memory store
    },
  };

  return store;
}
