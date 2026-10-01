import { pluginDataKey } from "../common/keys.js";
import { applyPagination } from "../common/pagination.js";
import type { MemoryState, MemoryStoreMethods } from "./memory-types.js";
import {
  pluginDataVersion,
  validatePluginDataCasEntries,
} from "../common/plugin-data-batch-cas.js";

export function createPluginDataMethods(
  state: MemoryState,
): MemoryStoreMethods {
  return {
    async compareAndSetPluginDataBatch(sessionId, pluginId, entries) {
      validatePluginDataCasEntries(entries);
      const rows = entries.map((entry) => {
        const key = pluginDataKey(
          sessionId,
          pluginId,
          entry.namespace,
          entry.key,
        );
        return { entry, key, existing: state.pluginData.get(key) };
      });
      if (
        rows.some(({ entry, existing }) =>
          entry.expectedVersion === null
            ? existing !== undefined
            : !existing ||
              pluginDataVersion(existing.value) !== entry.expectedVersion,
        )
      )
        return false;
      // No await between comparison and write: the serialized memory gate owns
      // this complete batch, including reads and transaction rollback snapshots.
      const next = rows.map(({ entry, key, existing }) => ({
        key,
        record: {
          id: existing?.id ?? crypto.randomUUID(),
          sessionId,
          pluginId,
          namespace: entry.namespace,
          key: entry.key,
          value: structuredClone(entry.value),
          createdAt: existing?.createdAt ?? entry.timestamp,
          updatedAt: entry.timestamp,
        },
      }));
      for (const { key, record } of next) state.pluginData.set(key, record);
      return true;
    },

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

    async compareAndSetPluginData(record, expectedUpdatedAt) {
      const key = pluginDataKey(
        record.sessionId,
        record.pluginId,
        record.namespace,
        record.key,
      );
      const existing = state.pluginData.get(key);
      if (
        expectedUpdatedAt === null
          ? existing !== undefined
          : existing?.updatedAt !== expectedUpdatedAt
      ) {
        return false;
      }
      state.pluginData.set(key, record);
      return true;
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
  };
}
