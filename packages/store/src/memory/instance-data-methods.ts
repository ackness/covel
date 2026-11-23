import { sortInstanceData } from "../common/sql-instance-data-records.js";
import type { InstanceDataRecord } from "../types.js";
import type { MemoryState, MemoryStoreMethods } from "./memory-types.js";

function instanceDataMapKey(
  pluginId: string,
  namespace: string,
  key: string,
): string {
  return JSON.stringify([pluginId, namespace, key]);
}

function normalizeJsonValue(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value) ?? "null") as unknown;
}

export function createInstanceDataMethods(
  state: MemoryState,
): MemoryStoreMethods {
  return {
    async getInstanceData(pluginId, namespace, key) {
      return (
        state.instanceData.get(instanceDataMapKey(pluginId, namespace, key)) ??
        null
      );
    },

    async listInstanceData(pluginId, namespace?) {
      const records: InstanceDataRecord[] = [];
      for (const record of state.instanceData.values()) {
        if (record.pluginId !== pluginId) continue;
        if (namespace !== undefined && record.namespace !== namespace) continue;
        records.push(record);
      }
      return sortInstanceData(records);
    },

    async upsertInstanceData(record) {
      const mapKey = instanceDataMapKey(
        record.pluginId,
        record.namespace,
        record.key,
      );
      const existing = state.instanceData.get(mapKey);
      state.instanceData.set(mapKey, {
        pluginId: record.pluginId,
        namespace: record.namespace,
        key: record.key,
        value: normalizeJsonValue(record.value),
        createdAt: existing?.createdAt ?? record.createdAt,
        updatedAt: record.updatedAt,
      });
    },

    async deleteInstanceData(pluginId, namespace, key) {
      return state.instanceData.delete(
        instanceDataMapKey(pluginId, namespace, key),
      );
    },

    async deletePluginInstanceData(pluginId) {
      let deleted = 0;
      for (const [mapKey, record] of state.instanceData) {
        if (record.pluginId === pluginId) {
          state.instanceData.delete(mapKey);
          deleted += 1;
        }
      }
      return deleted;
    },
  };
}
