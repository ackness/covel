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

    async createWorld(record) {
      if (state.worlds.has(record.id)) return false;
      state.worlds.set(record.id, normalizeWorldRecord(record));
      return true;
    },

    async upsertWorld(record) {
      state.worlds.set(record.id, normalizeWorldRecord(record));
    },

    async deleteWorld(id) {
      state.worlds.delete(id);
    },
  };
}
