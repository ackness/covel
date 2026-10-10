import {
  applyCursorAfter,
  applyPagination,
  applyWriteOrderPage,
  compareByteOrder,
  sortByCursorAsc,
  sortByWriteOrder,
} from "../common/pagination.js";
import { characterKey, stateEntryKey } from "../common/keys.js";
import type { TurnMessageRecord } from "../types.js";
import { computeTurnMessageStats } from "../common/turn-message-stats.js";
import {
  adoptPlayerInputMessage,
  assertCommittedPlayerInput,
} from "../common/player-input-message.js";
import type { SessionSummaryRecord } from "../types.js";
import { settleFailedRuntimeResults } from "../records/runtime-records.js";
import { replaceArrayContents } from "./collection-helpers.js";
import type { MemoryState, MemoryStoreMethods } from "./memory-types.js";

/** The JS mirror of `turnMessageOrder` in `common/sql-session-journal-records.ts`. */
function sortTurnMessages(
  rows: readonly TurnMessageRecord[],
): TurnMessageRecord[] {
  return [...rows].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    if (a.order !== b.order) return a.order - b.order;
    return compareByteOrder(a.id, b.id);
  });
}

export function createRuntimeMethods(state: MemoryState): MemoryStoreMethods {
  return {
    async saveTurnResult(record) {
      state.turnResults.push(record);
    },

    async setTurnResultCommitStatus(
      sessionId,
      turnId,
      status,
      failedRuntimes = [],
    ) {
      for (let i = 0; i < state.turnResults.length; i += 1) {
        const row = state.turnResults[i]!;
        if (row.sessionId === sessionId && row.turnId === turnId) {
          state.turnResults[i] = {
            ...row,
            commitStatus: status,
            runtimeResults: settleFailedRuntimeResults(
              row.runtimeResults,
              failedRuntimes,
            ),
          };
        }
      }
    },

    async listTurnResults(sessionId, limit?) {
      const filtered = state.turnResults
        .filter((r) => r.sessionId === sessionId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return limit !== undefined ? filtered.slice(0, limit) : filtered;
    },

    async queryTurnResults(sessionId, options) {
      const rows = sortByWriteOrder(
        state.turnResults.filter(
          (row) =>
            row.sessionId === sessionId &&
            !row.parentTurnId &&
            row.origin !== "recursive" &&
            (options.turnId === undefined || row.turnId === options.turnId) &&
            (options.since === undefined || row.createdAt >= options.since) &&
            (options.origins === undefined ||
              options.origins.includes(row.origin)) &&
            (options.commitStatus === undefined ||
              row.commitStatus === options.commitStatus),
        ),
      );
      if (options.newestFirst) rows.reverse();
      return options.limit === undefined ? rows : rows.slice(0, options.limit);
    },

    async saveToolCall(record) {
      state.toolCalls.push(record);
    },

    async listToolCalls(sessionId, turnId?) {
      return sortByCursorAsc(
        state.toolCalls.filter(
          (r) =>
            r.sessionId === sessionId &&
            (turnId === undefined || r.turnId === turnId),
        ),
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
      // `id` tie-break mirrors the SQL backends so offset paging is stable.
      rows = [...rows].sort(
        (a, b) =>
          b.timestamp.localeCompare(a.timestamp) ||
          compareByteOrder(b.id, a.id),
      );
      const offset = filters?.offset ?? 0;
      if (offset > 0 || filters?.limit !== undefined) {
        rows = rows.slice(
          offset,
          filters?.limit === undefined ? undefined : offset + filters.limit,
        );
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
      // A second save under one `id` replaces that row's schema and nothing
      // else, as the SQL upsert does.
      const index = state.stateSchemas.findIndex((r) => r.id === record.id);
      if (index === -1) {
        state.stateSchemas.push(record);
      } else {
        // Replace instead of mutating: transaction snapshots share row objects.
        state.stateSchemas[index] = {
          ...state.stateSchemas[index]!,
          schema: record.schema,
        };
      }
    },

    async listStateSchemas(sessionId) {
      return state.stateSchemas.filter((r) => r.sessionId === sessionId);
    },

    async deleteStateSchema(sessionId, tableName) {
      // Every schema row of the table, as the SQL DELETE removes.
      replaceArrayContents(
        state.stateSchemas,
        state.stateSchemas.filter(
          (r) => r.sessionId !== sessionId || r.tableName !== tableName,
        ),
      );
    },

    async getStateEntry(sessionId, tableName, fieldName) {
      return (
        state.stateEntries.get(
          stateEntryKey(sessionId, tableName, fieldName),
        ) ?? null
      );
    },

    async upsertStateEntry(record) {
      const key = stateEntryKey(
        record.sessionId,
        record.tableName,
        record.fieldName,
      );
      // Like the SQL update: the row keeps the ID it was inserted with.
      const existing = state.stateEntries.get(key);
      state.stateEntries.set(
        key,
        existing ? { ...record, id: existing.id } : record,
      );
    },

    async listStateEntries(sessionId, tableName) {
      return [...state.stateEntries.values()]
        .filter((r) => r.sessionId === sessionId && r.tableName === tableName)
        .sort((a, b) => compareByteOrder(a.fieldName, b.fieldName));
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

    async deleteEventsBefore(sessionId, before) {
      replaceArrayContents(
        state.events,
        state.events.filter(
          (row) => row.sessionId !== sessionId || row.createdAt >= before,
        ),
      );
    },

    async getEventById(sessionId, id) {
      return (
        state.events.find((r) => r.sessionId === sessionId && r.id === id) ??
        null
      );
    },

    async addMessage(record) {
      // Match the SQL messages table's global primary key: INSERT, not adopt.
      if (state.messagePositions.has(record.id)) {
        throw new Error(`Message already exists: ${record.id}`);
      }
      state.messagePositions.set(record.id, state.messages.length);
      state.messages.push(record);
    },

    async commitPlayerInputMessage(record) {
      assertCommittedPlayerInput(record);
      const index = state.messagePositions.get(record.id);
      if (index === undefined) {
        state.messagePositions.set(record.id, state.messages.length);
        state.messages.push(record);
      } else {
        // Replace instead of mutating: transaction snapshots share row objects.
        state.messages[index] = adoptPlayerInputMessage(
          state.messages[index]!,
          record,
        );
      }
    },

    async listMessages(sessionId, pagination?) {
      const sorted = sortByWriteOrder(
        state.messages.filter((r) => r.sessionId === sessionId),
      );
      return applyPagination(sorted, pagination);
    },

    async listMessagesPage(sessionId, opts) {
      const sorted = sortByWriteOrder(
        state.messages.filter((r) => r.sessionId === sessionId),
      );
      return applyWriteOrderPage(sorted, opts);
    },

    async getCharacterSchema(sessionId) {
      return state.characterSchemas.get(sessionId) ?? null;
    },

    async upsertCharacterSchema(record) {
      state.characterSchemas.set(record.sessionId, record);
    },

    async upsertCharacter(record) {
      state.characters.set(characterKey(record.sessionId, record.id), {
        ...record,
        fields: record.fields ?? undefined,
      });
    },

    async listCharacters(sessionId) {
      // An author writes a character ID, so it is compared as the SQL
      // backends compare it, byte by byte.
      return [...state.characters.values()]
        .filter((r) => r.sessionId === sessionId)
        .sort((a, b) => {
          if (a.createdAt !== b.createdAt)
            return a.createdAt < b.createdAt ? -1 : 1;
          return compareByteOrder(a.id, b.id);
        });
    },

    async deleteCharacter(sessionId, id) {
      state.characters.delete(characterKey(sessionId, id));
    },

    async addTraceEvent(record) {
      state.traceEvents.push(record);
    },

    async listTraceEvents(sessionId, pagination?) {
      // Sort by createdAt to match the SQL backends; the append order is
      // usually chronological but resume/replay/backfill can insert out of
      // order, and paging must return a stable time window.
      const sorted = sortByWriteOrder(
        state.traceEvents.filter((r) => r.sessionId === sessionId),
      );
      return applyPagination(sorted, pagination);
    },

    async getTraceEventById(sessionId, id) {
      return (
        state.traceEvents.find(
          (row) => row.sessionId === sessionId && row.id === id,
        ) ?? null
      );
    },

    async queryTraceEvents(sessionId, options) {
      const rows = sortByWriteOrder(
        state.traceEvents.filter(
          (row) =>
            row.sessionId === sessionId &&
            (options.turnId === undefined || row.turnId === options.turnId) &&
            (options.types === undefined || options.types.includes(row.type)) &&
            !options.excludeTypes?.includes(row.type),
        ),
      );
      if (options.newestFirst) rows.reverse();
      return options.limit === undefined ? rows : rows.slice(0, options.limit);
    },

    async deleteTraceEventsBefore(sessionId, before) {
      replaceArrayContents(
        state.traceEvents,
        state.traceEvents.filter(
          (r) => r.sessionId !== sessionId || r.createdAt >= before,
        ),
      );
    },

    async listTraceEventsPage(sessionId, opts) {
      const sorted = sortByWriteOrder(
        state.traceEvents.filter((r) => r.sessionId === sessionId),
      );
      return applyWriteOrderPage(sorted, opts);
    },

    async appendTurnMessage(record) {
      // Match the SQL turn_messages primary key: a duplicate id is an error.
      if (state.turnMessages.some((r) => r.id === record.id)) {
        throw new Error(`Turn message already exists: ${record.id}`);
      }
      state.turnMessages.push(record);
    },

    async listTurnMessages(sessionId, pagination?) {
      const filtered = sortTurnMessages(
        state.turnMessages.filter((r) => r.sessionId === sessionId),
      );
      return applyPagination(filtered, pagination);
    },

    async listUncompactedTurnMessages(sessionId, limit) {
      return sortTurnMessages(
        state.turnMessages.filter(
          (r) => r.sessionId === sessionId && r.compactedAtTurnId == null,
        ),
      ).slice(0, limit);
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
      const sorted = sortTurnMessages(
        state.turnMessages.filter((r) => r.sessionId === sessionId),
      );
      return sorted.slice(-limit);
    },

    async savePlayerInput(record) {
      state.playerInputs.push(record);
    },

    async getLatestPlayerInput(sessionId) {
      let newest: import("../types.js").PlayerInputRecord | null = null;
      for (const row of state.playerInputs) {
        if (row.sessionId !== sessionId) continue;
        if (
          !newest ||
          row.createdAt > newest.createdAt ||
          (row.createdAt === newest.createdAt &&
            compareByteOrder(row.id, newest.id) > 0)
        )
          newest = row;
      }
      return newest;
    },

    async listPlayerInputs(sessionId) {
      return sortByCursorAsc(
        state.playerInputs.filter((r) => r.sessionId === sessionId),
      );
    },

    async saveSessionSummary(record: SessionSummaryRecord): Promise<void> {
      state.sessionSummaries.push(record);
    },

    async listSessionSummaries(
      sessionId: string,
    ): Promise<readonly SessionSummaryRecord[]> {
      return sortByCursorAsc(
        state.sessionSummaries.filter((r) => r.sessionId === sessionId),
      );
    },

    async deleteSessionSummaries(
      sessionId: string,
      summaryIds?: readonly string[],
    ): Promise<void> {
      const selected = summaryIds ? new Set(summaryIds) : undefined;
      for (let i = state.sessionSummaries.length - 1; i >= 0; i -= 1) {
        const summary = state.sessionSummaries[i]!;
        if (
          summary.sessionId === sessionId &&
          (!selected || selected.has(summary.id))
        ) {
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

    async retagCompactedTurnMessages(
      sessionId: string,
      summaryId: string,
      sourceSummaryIds?: readonly string[],
    ): Promise<void> {
      const selected = sourceSummaryIds ? new Set(sourceSummaryIds) : undefined;
      for (let i = 0; i < state.turnMessages.length; i += 1) {
        const msg = state.turnMessages[i]!;
        if (
          msg.sessionId === sessionId &&
          msg.compactedAtTurnId != null &&
          (!selected || selected.has(msg.compactedAtTurnId))
        ) {
          state.turnMessages[i] = { ...msg, compactedAtTurnId: summaryId };
        }
      }
    },
  };
}
