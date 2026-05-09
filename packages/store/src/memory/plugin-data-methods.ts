import { pluginConfigKey, pluginDataKey } from "../common/keys.js";
import { applyPagination } from "../common/pagination.js";
import type { MemoryState, MemoryStoreMethods } from "./memory-types.js";

export function createPluginDataMethods(
  state: MemoryState,
): MemoryStoreMethods {
  return {
    async setPluginData(record) {
      state.pluginData.set(
        pluginDataKey(
          record.sessionId,
          record.pluginId,
          record.namespace,
          record.key,
        ),
        record,
      );
    },

    async setPluginDataBatch(records) {
      for (const record of records) {
        state.pluginData.set(
          pluginDataKey(
            record.sessionId,
            record.pluginId,
            record.namespace,
            record.key,
          ),
          record,
        );
      }
    },

    async getPluginData(sessionId, pluginId, namespace, key) {
      return (
        state.pluginData.get(
          pluginDataKey(sessionId, pluginId, namespace, key),
        ) ?? null
      );
    },

    async listPluginData(sessionId, pluginId, namespace?, pagination?) {
      const filtered = [...state.pluginData.values()].filter(
        (r) =>
          r.sessionId === sessionId &&
          r.pluginId === pluginId &&
          (namespace === undefined || r.namespace === namespace),
      );
      return applyPagination(filtered, pagination);
    },

    async listPluginDataSessionScope(sessionId, pagination?) {
      const filtered = [...state.pluginData.values()].filter(
        (r) => r.sessionId === sessionId,
      );
      return applyPagination(filtered, pagination);
    },

    async deletePluginData(sessionId, pluginId, namespace, key) {
      state.pluginData.delete(
        pluginDataKey(sessionId, pluginId, namespace, key),
      );
    },

    async savePluginConfig(record) {
      state.pluginConfigs.set(
        pluginConfigKey(record.sessionId, record.pluginId),
        record,
      );
    },

    async getPluginConfig(sessionId, pluginId) {
      return (
        state.pluginConfigs.get(pluginConfigKey(sessionId, pluginId)) ?? null
      );
    },
  };
}
