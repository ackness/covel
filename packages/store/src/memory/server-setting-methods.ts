import { sortServerSettings } from "../common/sql-server-setting-records.js";
import type { MemoryState, MemoryStoreMethods } from "./memory-types.js";

export function createServerSettingMethods(
  state: MemoryState,
): MemoryStoreMethods {
  return {
    async listServerSettings() {
      return sortServerSettings([...state.serverSettings.values()]);
    },

    async setServerSetting(record) {
      state.serverSettings.set(record.key, {
        key: record.key,
        // The SQL backends keep JSON text, so only JSON survives here too.
        value: JSON.parse(JSON.stringify(record.value)) as unknown,
        updatedAt: record.updatedAt,
      });
    },

    async deleteServerSetting(key) {
      state.serverSettings.delete(key);
    },
  };
}
