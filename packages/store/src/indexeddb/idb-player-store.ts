import type { PlayerInputRecord } from "../types.js";
import type { IdbStoreContext, IdbStoreSlice } from "./idb-context.js";

export function createIdbPlayerStore(ctx: IdbStoreContext): IdbStoreSlice {
  const { db, mutations } = ctx;

  return {
    async savePlayerInput(record: PlayerInputRecord): Promise<void> {
      await mutations.putAndTrack("playerInputs", structuredClone(record));
    },

    async listPlayerInputs(sessionId: string): Promise<PlayerInputRecord[]> {
      return db.getAllFromIndex("playerInputs", "sessionId", sessionId);
    },
  };
}
