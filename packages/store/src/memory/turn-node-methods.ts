import type { MemoryState, MemoryStoreMethods } from "./memory-types.js";
import type { TurnNodeRecord } from "../types.js";
import { SessionRecordScopeConflictError } from "../errors.js";

export function createTurnNodeMethods(state: MemoryState): MemoryStoreMethods {
  return {
    async saveTurnNode(record: TurnNodeRecord) {
      const existing = state.turnNodes.get(record.id);
      if (existing && existing.sessionId !== record.sessionId) {
        throw new SessionRecordScopeConflictError("turn_node", record.id);
      }
      state.turnNodes.set(record.id, structuredClone(record));
    },
    async getTurnNode(id: string) {
      const record = state.turnNodes.get(id);
      return record ? structuredClone(record) : null;
    },
    async listTurnNodes(sessionId: string) {
      return [...state.turnNodes.values()]
        .filter((record) => record.sessionId === sessionId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((record) => structuredClone(record));
    },
    async deleteTurnNode(id: string) {
      state.turnNodes.delete(id);
    },
  };
}
