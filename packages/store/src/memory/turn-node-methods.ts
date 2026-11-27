import type { MemoryState, MemoryStoreMethods } from "./memory-types.js";
import type { TurnNodeRecord } from "../types.js";

export function createTurnNodeMethods(state: MemoryState): MemoryStoreMethods {
  return {
    async saveTurnNode(record: TurnNodeRecord) {
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
