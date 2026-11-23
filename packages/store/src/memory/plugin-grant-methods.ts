import { sortPluginGrants } from "../common/sql-plugin-grant-records.js";
import type { MemoryState, MemoryStoreMethods } from "./memory-types.js";

export function createPluginGrantMethods(
  state: MemoryState,
): MemoryStoreMethods {
  return {
    async listPluginGrants() {
      return sortPluginGrants([...state.pluginGrants.values()]);
    },

    async getPluginGrant(pluginId) {
      return state.pluginGrants.get(pluginId) ?? null;
    },

    async upsertPluginGrant(record) {
      state.pluginGrants.set(
        record.pluginId,
        // Match SQL text serialization so MemoryStore drops undefined/non-JSON fields identically.
        JSON.parse(JSON.stringify(record)) as typeof record,
      );
    },

    async deletePluginGrant(pluginId) {
      state.pluginGrants.delete(pluginId);
    },
  };
}
