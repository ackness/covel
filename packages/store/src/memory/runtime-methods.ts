import {
  applyCursorAfter,
  applyCursorPage,
  applyPagination,
  sortByCursorAsc,
} from "../common/pagination.js";
import { stateEntryKey } from "../common/keys.js";
import { computeTurnMessageStats } from "../common/turn-message-stats.js";
import type { SessionSummaryRecord } from "../types.js";
import type { MemoryState, MemoryStoreMethods } from "./memory-types.js";

export function createRuntimeMethods(state: MemoryState): MemoryStoreMethods {
  return {
    async saveTurnResult(record) {
      state.turnResults.push(record);
    },

    async listTurnResults(sessionId, limit?) {
      const filtered = state.turnResults
        .filter((r) => r.sessionId === sessionId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return limit !== undefined ? filtered.slice(0, limit) : filtered;
    },

    async saveRuntimeResult(record) {
      state.runtimeResults.push(record);
    },

    async listRuntimeResults(sessionId, turnId) {
      return state.runtimeResults.filter(
        (r) => r.sessionId === sessionId && r.turnId === turnId,
      );
    },

    async saveToolCall(record) {
      state.toolCalls.push(record);
    },

    async listToolCalls(sessionId, turnId?) {
      return state.toolCalls.filter(
        (r) =>
          r.sessionId === sessionId &&
          (turnId === undefined || r.turnId === turnId),
      );
    },

    async saveRuntimeOutput(record) {
      state.runtimeOutputs.push(record);
    },

    async getRuntimeOutput(sessionId, id) {
      return (
        state.runtimeOutputs.find(
          (r) => r.sessionId === sessionId && r.id === id,
        ) ?? null
      );
    },

    async listRuntimeOutputs(sessionId, filters) {
      let rows = state.runtimeOutputs.filter((r) => r.sessionId === sessionId);
      if (filters?.runtimeId) {
        rows = rows.filter((r) => r.runtimeId === filters.runtimeId);
      }
      if (filters?.pluginId) {
        rows = rows.filter((r) => r.pluginId === filters.pluginId);
      }
      if (filters?.sinceTimestamp) {
        rows = rows.filter((r) => r.timestamp >= filters.sinceTimestamp!);
      }
      rows = [...rows].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      if (filters?.limit !== undefined) {
        rows = rows.slice(0, filters.limit);
      }
      return rows;
    },

    async saveInteractionRecord(record) {
      state.interactionRecords.push(record);
    },

    async listInteractionRecords(sessionId, filters) {
      let rows = state.interactionRecords.filter(
        (r) => r.sessionId === sessionId,
      );
      if (filters?.type) {
        rows = rows.filter((r) => r.type === filters.type);
      }
      if (filters?.source) {
        rows = rows.filter((r) => r.source === filters.source);
      }
      if (filters?.targetPluginId) {
        rows = rows.filter((r) => r.targetPluginId === filters.targetPluginId);
      }
      rows = [...rows].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      if (filters?.limit !== undefined) {
        rows = rows.slice(0, filters.limit);
      }
      return rows;
    },

    async saveStateSchema(record) {
      state.stateSchemas.push(record);
    },

    async listStateSchemas(sessionId) {
      return state.stateSchemas.filter((r) => r.sessionId === sessionId);
    },

    async deleteStateSchema(sessionId, tableName) {
      const idx = state.stateSchemas.findIndex(
        (r) => r.sessionId === sessionId && r.tableName === tableName,
      );
      if (idx !== -1) state.stateSchemas.splice(idx, 1);
    },

    async getStateEntry(sessionId, tableName, fieldName) {
      return (
        state.stateEntries.get(
          stateEntryKey(sessionId, tableName, fieldName),
        ) ?? null
      );
    },

    async upsertStateEntry(record) {
      state.stateEntries.set(
        stateEntryKey(record.sessionId, record.tableName, record.fieldName),
        record,
      );
    },

    async listStateEntries(sessionId, tableName) {
      return [...state.stateEntries.values()].filter(
        (r) => r.sessionId === sessionId && r.tableName === tableName,
      );
    },

    async addStateChange(record) {
      state.stateChanges.push(record);
    },

    async listStateChanges(sessionId, tableName, fieldName) {
      return state.stateChanges
        .filter(
          (r) =>
            r.sessionId === sessionId &&
            r.tableName === tableName &&
            r.fieldName === fieldName,
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    async saveEvent(record) {
      state.events.push(record);
    },

    async listEvents(sessionId, options?) {
      let filtered = state.events.filter((r) => r.sessionId === sessionId);
      if (options?.topic !== undefined) {
        filtered = filtered.filter((r) => r.topic === options.topic);
      }
      if (options?.limit !== undefined) {
        filtered = filtered.slice(0, options.limit);
      }
      return filtered;
    },

    async getEventById(sessionId, id) {
      return (
        state.events.find((r) => r.sessionId === sessionId && r.id === id) ??
        null
      );
    },

    async saveApproval(record) {
      state.approvals.push(record);
    },

    async listApprovals(sessionId) {
      return state.approvals.filter((r) => r.sessionId === sessionId);
    },

    async addMessage(record) {
      state.messages.push(record);
    },

    async listMessages(sessionId, pagination?) {
      const filtered = state.messages
        .filter((r) => r.sessionId === sessionId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return applyPagination(filtered, pagination);
    },

    async listMessagesPage(sessionId, opts) {
      const sorted = sortByCursorAsc(
        state.messages.filter((r) => r.sessionId === sessionId),
      );
      return applyCursorPage(sorted, opts);
    },

    async upsertCharacter(record) {
      state.characters.set(record.id, record);
    },

    async listCharacters(sessionId) {
      return [...state.characters.values()].filter(
        (r) => r.sessionId === sessionId,
      );
    },

    async deleteCharacter(sessionId, id) {
      const existing = state.characters.get(id);
      if (existing?.sessionId === sessionId) {
        state.characters.delete(id);
      }
    },

    async addTraceEvent(record) {
      state.traceEvents.push(record);
    },

    async listTraceEvents(sessionId, pagination?) {
      // Sort by createdAt to match the SQL backends (`asc(createdAt)`); the
      // append order is usually chronological but resume/replay/backfill can
      // insert out of order, and paging must return a stable time window.
      const filtered = state.traceEvents
        .filter((r) => r.sessionId === sessionId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return applyPagination(filtered, pagination);
    },

    async listTraceEventsPage(sessionId, opts) {
      const sorted = sortByCursorAsc(
        state.traceEvents.filter((r) => r.sessionId === sessionId),
      );
      return applyCursorPage(sorted, opts);
    },

    async appendTurnMessage(record) {
      state.turnMessages.push(record);
    },

    async listTurnMessages(sessionId, pagination?) {
      const filtered = state.turnMessages
        .filter((r) => r.sessionId === sessionId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return applyPagination(filtered, pagination);
    },

    async listUncompactedTurnMessages(sessionId) {
      return state.turnMessages
        .filter((r) => r.sessionId === sessionId && r.compactedAtTurnId == null)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    async getTurnMessageStats(sessionId) {
      return computeTurnMessageStats(
        state.turnMessages.filter((r) => r.sessionId === sessionId),
      );
    },

    async listTurnMessagesAfter(sessionId, after, limit) {
      const sorted = sortByCursorAsc(
        state.turnMessages.filter((r) => r.sessionId === sessionId),
      );
      return applyCursorAfter(sorted, after, limit);
    },

    async listRecentTurnMessages(sessionId, limit) {
      if (limit <= 0) return [];
      const sorted = sortByCursorAsc(
        state.turnMessages.filter((r) => r.sessionId === sessionId),
      );
      return sorted.slice(-limit);
    },

    async savePlayerInput(record) {
      state.playerInputs.push(record);
    },

    async listPlayerInputs(sessionId) {
      return state.playerInputs.filter((r) => r.sessionId === sessionId);
    },

    async saveSessionSummary(record: SessionSummaryRecord): Promise<void> {
      state.sessionSummaries.push(record);
    },

    async listSessionSummaries(
      sessionId: string,
    ): Promise<readonly SessionSummaryRecord[]> {
      return state.sessionSummaries.filter((r) => r.sessionId === sessionId);
    },

    async deleteSessionSummaries(sessionId: string): Promise<void> {
      for (let i = state.sessionSummaries.length - 1; i >= 0; i -= 1) {
        if (state.sessionSummaries[i]!.sessionId === sessionId) {
          state.sessionSummaries.splice(i, 1);
        }
      }
    },

    async tagTurnMessagesCompacted(
      sessionId: string,
      messageIds: readonly string[],
      summaryId: string,
    ): Promise<void> {
      const idSet = new Set(messageIds);
      for (let i = 0; i < state.turnMessages.length; i += 1) {
        const msg = state.turnMessages[i]!;
        if (msg.sessionId === sessionId && idSet.has(msg.id)) {
          state.turnMessages[i] = { ...msg, compactedAtTurnId: summaryId };
        }
      }
    },
  };
}
