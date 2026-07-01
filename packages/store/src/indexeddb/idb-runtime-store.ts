import type {
  ApprovalRecord,
  CursorPageOpts,
  EventRecord,
  InteractionRecordFilters,
  InteractionRecordRow,
  MessageRecord,
  PaginationOpts,
  RuntimeOutputFilters,
  RuntimeOutputRecord,
  RuntimeResultRecord,
  StateChangeRecord,
  StateEntryRecord,
  StateSchemaRecord,
  ToolCallRecordRow,
  TraceEventRecord,
  TurnMessageRecord,
  TurnResultRecord,
} from "../types.js";
import { applyCursorPage, sortByCursorAsc } from "../common/pagination.js";
import type { IdbStoreContext, IdbStoreSlice } from "./idb-context.js";
import {
  filterInteractionRecords,
  filterRuntimeOutputs,
  getSessionScopedRecord,
  limitRows,
  listBySession,
  paginateRows,
  putClonedRecord,
  sortByCreatedAtAsc,
} from "./idb-record-helpers.js";

export function createIdbRuntimeStore(ctx: IdbStoreContext): IdbStoreSlice {
  const { db, mutations } = ctx;

  return {
    async saveTurnResult(record: TurnResultRecord): Promise<void> {
      await putClonedRecord(mutations, "turnResults", record);
    },

    async getTurnResult(
      sessionId: string,
      turnId: string,
    ): Promise<TurnResultRecord | null> {
      const all = await db.getAllFromIndex(
        "turnResults",
        "sessionId",
        sessionId,
      );
      return all.find((r) => r.turnId === turnId) ?? null;
    },

    async listTurnResults(
      sessionId: string,
      limit?: number,
    ): Promise<TurnResultRecord[]> {
      const all = await db.getAllFromIndex(
        "turnResults",
        "sessionId",
        sessionId,
      );
      return limitRows(sortByCreatedAtAsc(all), limit);
    },

    async saveRuntimeResult(record: RuntimeResultRecord): Promise<void> {
      await putClonedRecord(mutations, "runtimeResults", record);
    },

    async listRuntimeResults(
      sessionId: string,
      turnId: string,
    ): Promise<RuntimeResultRecord[]> {
      return db.getAllFromIndex("runtimeResults", "sessionId_turnId", [
        sessionId,
        turnId,
      ]);
    },

    async saveToolCall(record: ToolCallRecordRow): Promise<void> {
      await putClonedRecord(mutations, "toolCalls", record);
    },

    async listToolCalls(
      sessionId: string,
      turnId?: string,
    ): Promise<ToolCallRecordRow[]> {
      if (turnId !== undefined) {
        return db.getAllFromIndex("toolCalls", "sessionId_turnId", [
          sessionId,
          turnId,
        ]);
      }
      return db.getAllFromIndex("toolCalls", "sessionId", sessionId);
    },

    async saveStateSchema(record: StateSchemaRecord): Promise<void> {
      await putClonedRecord(mutations, "stateSchemas", record);
    },

    async listStateSchemas(sessionId: string): Promise<StateSchemaRecord[]> {
      return listBySession(db, "stateSchemas", sessionId);
    },

    async deleteStateSchema(
      sessionId: string,
      tableName: string,
    ): Promise<void> {
      const all = await db.getAllFromIndex(
        "stateSchemas",
        "sessionId",
        sessionId,
      );
      const target = all.find((r) => r.tableName === tableName);
      if (target) {
        await mutations.deleteAndTrack("stateSchemas", target.id);
      }
    },

    async getStateEntry(
      sessionId: string,
      tableName: string,
      fieldName: string,
    ): Promise<StateEntryRecord | null> {
      const results = await db.getAllFromIndex("stateEntries", "lookup", [
        sessionId,
        tableName,
        fieldName,
      ]);
      return results[0] ?? null;
    },

    async upsertStateEntry(record: StateEntryRecord): Promise<void> {
      const existing = await db.getAllFromIndex("stateEntries", "lookup", [
        record.sessionId,
        record.tableName,
        record.fieldName,
      ]);
      await mutations.ensureStoreSnapshot("stateEntries");
      const tx = db.transaction("stateEntries", "readwrite");
      for (const old of existing) {
        await tx.store.delete(old.id);
      }
      await tx.store.put(structuredClone(record));
      await tx.done;
    },

    async listStateEntries(
      sessionId: string,
      tableName: string,
    ): Promise<StateEntryRecord[]> {
      const all = await db.getAllFromIndex(
        "stateEntries",
        "sessionId",
        sessionId,
      );
      return all.filter((r) => r.tableName === tableName);
    },

    async addStateChange(record: StateChangeRecord): Promise<void> {
      await putClonedRecord(mutations, "stateChanges", record);
    },

    async listStateChanges(
      sessionId: string,
      tableName: string,
      fieldName: string,
    ): Promise<StateChangeRecord[]> {
      const all = await db.getAllFromIndex(
        "stateChanges",
        "sessionId",
        sessionId,
      );
      return all
        .filter((r) => r.tableName === tableName && r.fieldName === fieldName)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    async saveEvent(record: EventRecord): Promise<void> {
      await putClonedRecord(mutations, "events", record);
    },

    async listEvents(
      sessionId: string,
      options?: { topic?: string; limit?: number },
    ): Promise<EventRecord[]> {
      let filtered = await db.getAllFromIndex("events", "sessionId", sessionId);
      if (options?.topic !== undefined) {
        filtered = filtered.filter((r) => r.topic === options.topic);
      }
      if (options?.limit !== undefined) {
        filtered = filtered.slice(0, options.limit);
      }
      return filtered;
    },

    async saveApproval(record: ApprovalRecord): Promise<void> {
      await putClonedRecord(mutations, "approvals", record);
    },

    async listApprovals(sessionId: string): Promise<ApprovalRecord[]> {
      return listBySession(db, "approvals", sessionId);
    },

    async addMessage(record: MessageRecord): Promise<void> {
      await putClonedRecord(mutations, "messages", record);
    },

    async listMessages(
      sessionId: string,
      pagination?: PaginationOpts,
    ): Promise<MessageRecord[]> {
      const all = await listBySession<MessageRecord>(db, "messages", sessionId);
      return paginateRows(sortByCreatedAtAsc(all), pagination);
    },

    async listMessagesPage(
      sessionId: string,
      opts: CursorPageOpts,
    ): Promise<MessageRecord[]> {
      const all = await listBySession<MessageRecord>(db, "messages", sessionId);
      return applyCursorPage(sortByCursorAsc(all), opts);
    },

    async addTraceEvent(record: TraceEventRecord): Promise<void> {
      await putClonedRecord(mutations, "traceEvents", record);
    },

    async listTraceEvents(
      sessionId: string,
      pagination?: PaginationOpts,
    ): Promise<TraceEventRecord[]> {
      const all = await db.getAllFromIndex(
        "traceEvents",
        "sessionId",
        sessionId,
      );
      // The IDB `sessionId` index yields rows in primary-key (random uuid)
      // order, not time order — sort by createdAt so paging returns a stable,
      // chronological window (matches listMessages/listTurnMessages). Without
      // this, turn-grouped trace views on the browser-local backend saw events
      // in effectively random order.
      return paginateRows(sortByCreatedAtAsc(all), pagination);
    },

    async listTraceEventsPage(
      sessionId: string,
      opts: CursorPageOpts,
    ): Promise<TraceEventRecord[]> {
      const all = await db.getAllFromIndex(
        "traceEvents",
        "sessionId",
        sessionId,
      );
      return applyCursorPage(sortByCursorAsc(all), opts);
    },

    async saveRuntimeOutput(record: RuntimeOutputRecord): Promise<void> {
      await putClonedRecord(mutations, "runtime_outputs", record);
    },

    async getRuntimeOutput(
      sessionId: string,
      id: string,
    ): Promise<RuntimeOutputRecord | null> {
      return getSessionScopedRecord(db, "runtime_outputs", sessionId, id);
    },

    async listRuntimeOutputs(
      sessionId: string,
      filters?: RuntimeOutputFilters,
    ): Promise<RuntimeOutputRecord[]> {
      const rows = await listBySession<RuntimeOutputRecord>(
        db,
        "runtime_outputs",
        sessionId,
      );
      return filterRuntimeOutputs(rows, filters);
    },

    async saveInteractionRecord(record: InteractionRecordRow): Promise<void> {
      await putClonedRecord(mutations, "interaction_records", record);
    },

    async listInteractionRecords(
      sessionId: string,
      filters?: InteractionRecordFilters,
    ): Promise<InteractionRecordRow[]> {
      const rows = await listBySession<InteractionRecordRow>(
        db,
        "interaction_records",
        sessionId,
      );
      return filterInteractionRecords(rows, filters);
    },

    async appendTurnMessage(record: TurnMessageRecord): Promise<void> {
      await putClonedRecord(mutations, "turnMessages", record);
    },

    async listTurnMessages(
      sessionId: string,
      pagination?: PaginationOpts,
    ): Promise<TurnMessageRecord[]> {
      const all = await listBySession<TurnMessageRecord>(
        db,
        "turnMessages",
        sessionId,
      );
      return paginateRows(sortByCreatedAtAsc(all), pagination);
    },

    async listRecentTurnMessages(
      sessionId: string,
      limit: number,
    ): Promise<TurnMessageRecord[]> {
      if (limit <= 0) return [];
      const all = await listBySession<TurnMessageRecord>(
        db,
        "turnMessages",
        sessionId,
      );
      return sortByCursorAsc(all).slice(-limit);
    },
  };
}
