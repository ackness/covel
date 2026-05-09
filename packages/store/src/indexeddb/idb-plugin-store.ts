import { applyPagination } from "../common/pagination.js";
import type {
  PaginationOpts,
  PluginConfigRecord,
  PluginDataRecord,
} from "../types.js";
import type { IdbStoreContext, IdbStoreSlice } from "./idb-context.js";

export function createIdbPluginStore(ctx: IdbStoreContext): IdbStoreSlice {
  const { db, mutations } = ctx;

  return {
    async setPluginData(record: PluginDataRecord): Promise<void> {
      await mutations.ensureStoreSnapshot("plugin_data");
      const tx = db.transaction("plugin_data", "readwrite");
      const existing = await tx.store
        .index("lookup")
        .get([record.sessionId, record.pluginId, record.namespace, record.key]);
      if (existing) {
        await tx.store.delete(existing.id);
      }
      await tx.store.put(structuredClone(record));
      await tx.done;
    },

    async setPluginDataBatch(
      records: readonly PluginDataRecord[],
    ): Promise<void> {
      if (records.length === 0) return;
      await mutations.ensureStoreSnapshot("plugin_data");
      const tx = db.transaction("plugin_data", "readwrite");
      for (const record of records) {
        const existing = await tx.store
          .index("lookup")
          .get([
            record.sessionId,
            record.pluginId,
            record.namespace,
            record.key,
          ]);
        if (existing) {
          await tx.store.delete(existing.id);
        }
        await tx.store.put(structuredClone(record));
      }
      await tx.done;
    },

    async getPluginData(
      sessionId: string,
      pluginId: string,
      namespace: string,
      key: string,
    ): Promise<PluginDataRecord | null> {
      const results = await db.getAllFromIndex("plugin_data", "lookup", [
        sessionId,
        pluginId,
        namespace,
        key,
      ]);
      return results[0] ?? null;
    },

    async listPluginData(
      sessionId: string,
      pluginId: string,
      namespace?: string,
      pagination?: PaginationOpts,
    ): Promise<PluginDataRecord[]> {
      const all = await db.getAllFromIndex(
        "plugin_data",
        "sessionId_pluginId",
        [sessionId, pluginId],
      );
      const filtered =
        namespace === undefined
          ? all
          : all.filter((r) => r.namespace === namespace);
      return applyPagination(filtered, pagination);
    },

    async listPluginDataSessionScope(
      sessionId: string,
      pagination?: PaginationOpts,
    ): Promise<readonly PluginDataRecord[]> {
      const all = (await db.getAll("plugin_data")) as PluginDataRecord[];
      return applyPagination(
        all.filter((r) => r.sessionId === sessionId),
        pagination,
      );
    },

    async deletePluginData(
      sessionId: string,
      pluginId: string,
      namespace: string,
      key: string,
    ): Promise<void> {
      const existing = await db.getAllFromIndex("plugin_data", "lookup", [
        sessionId,
        pluginId,
        namespace,
        key,
      ]);
      for (const record of existing) {
        await mutations.deleteAndTrack("plugin_data", record.id);
      }
    },

    async savePluginConfig(record: PluginConfigRecord): Promise<void> {
      const existing = await db.getAllFromIndex("pluginConfigs", "lookup", [
        record.sessionId,
        record.pluginId,
      ]);
      await mutations.ensureStoreSnapshot("pluginConfigs");
      const tx = db.transaction("pluginConfigs", "readwrite");
      for (const old of existing) {
        await tx.store.delete(old.id);
      }
      await tx.store.put(structuredClone(record));
      await tx.done;
    },

    async getPluginConfig(
      sessionId: string,
      pluginId: string,
    ): Promise<PluginConfigRecord | null> {
      const results = await db.getAllFromIndex("pluginConfigs", "lookup", [
        sessionId,
        pluginId,
      ]);
      return results[0] ?? null;
    },
  };
}
