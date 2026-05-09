import { applyPagination } from "../common/pagination.js";
import type {
  ApprovalRecord,
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
import type { IdbStoreContext, IdbStoreSlice } from "./idb-context.js";

export function createIdbRuntimeStore(ctx: IdbStoreContext): IdbStoreSlice {
  const { db, mutations } = ctx;

  return {
    async saveTurnResult(record: TurnResultRecord): Promise<void> {
      await mutations.putAndTrack("turnResults", structuredClone(record));
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
      const sorted = all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return limit !== undefined ? sorted.slice(0, limit) : sorted;
    },

    async saveRuntimeResult(record: RuntimeResultRecord): Promise<void> {
      await mutations.putAndTrack("runtimeResults", structuredClone(record));
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
      await mutations.putAndTrack("toolCalls", structuredClone(record));
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
      await mutations.putAndTrack("stateSchemas", structuredClone(record));
    },

    async listStateSchemas(sessionId: string): Promise<StateSchemaRecord[]> {
      return db.getAllFromIndex("stateSchemas", "sessionId", sessionId);
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
      await mutations.putAndTrack("stateChanges", structuredClone(record));
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
      await mutations.putAndTrack("events", structuredClone(record));
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
      await mutations.putAndTrack("approvals", structuredClone(record));
    },

    async listApprovals(sessionId: string): Promise<ApprovalRecord[]> {
      return db.getAllFromIndex("approvals", "sessionId", sessionId);
    },

    async addMessage(record: MessageRecord): Promise<void> {
      await mutations.putAndTrack("messages", structuredClone(record));
    },

    async listMessages(
      sessionId: string,
      pagination?: PaginationOpts,
    ): Promise<MessageRecord[]> {
      const all = await db.getAllFromIndex("messages", "sessionId", sessionId);
      const sorted = all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return applyPagination(sorted, pagination);
    },

    async addTraceEvent(record: TraceEventRecord): Promise<void> {
      await mutations.putAndTrack("traceEvents", structuredClone(record));
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
      return applyPagination(all, pagination);
    },

    async saveRuntimeOutput(record: RuntimeOutputRecord): Promise<void> {
      await mutations.putAndTrack("runtime_outputs", structuredClone(record));
    },

    async getRuntimeOutput(
      sessionId: string,
      id: string,
    ): Promise<RuntimeOutputRecord | null> {
      const row = (await db.get("runtime_outputs", id)) as
        | RuntimeOutputRecord
        | undefined;
      if (!row || row.sessionId !== sessionId) return null;
      return row;
    },

    async listRuntimeOutputs(
      sessionId: string,
      filters?: RuntimeOutputFilters,
    ): Promise<RuntimeOutputRecord[]> {
      let rows = (await db.getAllFromIndex(
        "runtime_outputs",
        "sessionId",
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

    async saveInteractionRecord(record: InteractionRecordRow): Promise<void> {
      await mutations.putAndTrack(
        "interaction_records",
        structuredClone(record),
      );
    },

    async listInteractionRecords(
      sessionId: string,
      filters?: InteractionRecordFilters,
    ): Promise<InteractionRecordRow[]> {
      let rows = (await db.getAllFromIndex(
        "interaction_records",
        "sessionId",
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

    async appendTurnMessage(record: TurnMessageRecord): Promise<void> {
      await mutations.putAndTrack("turnMessages", structuredClone(record));
    },

    async listTurnMessages(
      sessionId: string,
      pagination?: PaginationOpts,
    ): Promise<TurnMessageRecord[]> {
      const all = await db.getAllFromIndex(
        "turnMessages",
        "sessionId",
        sessionId,
      );
      const sorted = all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return applyPagination(sorted, pagination);
    },
  };
}
