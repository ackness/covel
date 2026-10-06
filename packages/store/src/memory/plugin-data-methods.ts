import { pluginDataKey } from "../common/keys.js";
import { applyPagination, compareByteOrder } from "../common/pagination.js";
import type { PluginDataRecord } from "../types.js";
import type { MemoryState, MemoryStoreMethods } from "./memory-types.js";
import {
  pluginDataVersion,
  validatePluginDataCasEntries,
} from "../common/plugin-data-batch-cas.js";

/**
 * The order of every plugin-data list, the JS mirror of `pluginDataOrder` in
 * `common/sql-data-crud.ts`: `createdAt`, then the row's own key.
 */
function sortPluginData(rows: readonly PluginDataRecord[]): PluginDataRecord[] {
  const fields = ["pluginId", "namespace", "key"] as const;
  return [...rows].sort((a, b) => {
    // A timestamp is ASCII: `<` orders it as its bytes do.
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    for (const field of fields) {
      const order = compareByteOrder(a[field], b[field]);
      if (order !== 0) return order;
    }
    return 0;
  });
}

export function createPluginDataMethods(
  state: MemoryState,
): MemoryStoreMethods {
  // A rewrite changes the value and `updatedAt` only, as the SQL upsert does:
  // the row keeps its ID and its place in the lists.
  const write = (record: PluginDataRecord): void => {
    const key = pluginDataKey(
      record.sessionId,
      record.pluginId,
      record.namespace,
      record.key,
    );
    const existing = state.pluginData.get(key);
    state.pluginData.set(
      key,
      existing
        ? { ...record, id: existing.id, createdAt: existing.createdAt }
        : record,
    );
  };
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
      write(record);
    },

    async setPluginDataBatch(records) {
      for (const record of records) write(record);
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
      write(record);
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
      return applyPagination(sortPluginData(filtered), pagination);
    },

    async listPluginDataSessionScope(sessionId, pagination?) {
      const filtered = [...state.pluginData.values()].filter(
        (r) => r.sessionId === sessionId,
      );
      return applyPagination(sortPluginData(filtered), pagination);
    },

    async listPluginDataByNamespace(sessionId, namespace) {
      return sortPluginData(
        [...state.pluginData.values()].filter(
          (r) => r.sessionId === sessionId && r.namespace === namespace,
        ),
      );
    },

    async deletePluginData(sessionId, pluginId, namespace, key) {
      state.pluginData.delete(
        pluginDataKey(sessionId, pluginId, namespace, key),
      );
    },
  };
}
