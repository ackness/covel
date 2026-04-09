/**
 * In-memory DataStore implementation.
 * Used for testing and ephemeral sessions.
 */

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

export function createMemoryStore(): DataStore {
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
  const pluginConfigs = new Map<string, PluginConfigRecord>();
  const worlds = new Map<string, WorldRecord>();
  const traceEvents: TraceEventRecord[] = [];
  const turnMessages: TurnMessageRecord[] = [];
  const playerInputs: PlayerInputRecord[] = [];

  function stateEntryKey(sessionId: string, tableName: string, fieldName: string): string {
    return `${sessionId}:${tableName}:${fieldName}`;
  }

  function pluginConfigKey(sessionId: string, pluginId: string): string {
    return `${sessionId}:${pluginId}`;
  }

  const store: DataStore = {
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

    async listMessages(sessionId) {
      return messages
        .filter((r) => r.sessionId === sessionId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    // ── Characters ──

    async upsertCharacter(record) {
      characters.set(record.id, record);
    },

    async listCharacters(sessionId) {
      return [...characters.values()].filter((r) => r.sessionId === sessionId);
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

    async listTraceEvents(sessionId) {
      return traceEvents.filter((r) => r.sessionId === sessionId);
    },

    // ── Turn Messages ──

    async appendTurnMessage(record) {
      turnMessages.push(record);
    },

    async listTurnMessages(sessionId) {
      return turnMessages
        .filter((r) => r.sessionId === sessionId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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

    // ── Lifecycle ──

    async close() {
      // No-op for in-memory store
    },
  };

  return store;
}
