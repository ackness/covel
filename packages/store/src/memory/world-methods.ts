import { normalizeWorldRecord } from "../types.js";
import type { MemoryState, MemoryStoreMethods } from "./memory-types.js";

export function createWorldMethods(state: MemoryState): MemoryStoreMethods {
  return {
    async listWorlds() {
      return [...state.worlds.values()].map(normalizeWorldRecord);
    },

    async getWorld(id) {
      const world = state.worlds.get(id);
      return world ? normalizeWorldRecord(world) : null;
    },

    async upsertWorld(record) {
      state.worlds.set(record.id, normalizeWorldRecord(record));
    },

    async deleteWorld(id) {
      state.worlds.delete(id);
    },
  };
}
