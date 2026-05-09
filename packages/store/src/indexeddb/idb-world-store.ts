import { normalizeWorldRecord, type WorldRecord } from "../types.js";
import type { IdbStoreContext, IdbStoreSlice } from "./idb-context.js";

export function createIdbWorldStore(ctx: IdbStoreContext): IdbStoreSlice {
  const { db, mutations } = ctx;

  return {
    async listWorlds(): Promise<WorldRecord[]> {
      return (await db.getAll("worlds")).map(normalizeWorldRecord);
    },

    async getWorld(id: string): Promise<WorldRecord | null> {
      const world = (await db.get("worlds", id)) ?? null;
      return world ? normalizeWorldRecord(world) : null;
    },

    async upsertWorld(record: WorldRecord): Promise<void> {
      await mutations.putAndTrack(
        "worlds",
        structuredClone(normalizeWorldRecord(record)),
      );
    },

    async deleteWorld(id: string): Promise<void> {
      await mutations.deleteAndTrack("worlds", id);
    },
  };
}
