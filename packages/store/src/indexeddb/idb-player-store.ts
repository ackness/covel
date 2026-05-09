import type { PlayerInputRecord } from "../types.js";
import type { IdbStoreContext, IdbStoreSlice } from "./idb-context.js";

export function createIdbPlayerStore(ctx: IdbStoreContext): IdbStoreSlice {
  const { db, mutations } = ctx;

  return {
    async savePlayerInput(record: PlayerInputRecord): Promise<void> {
      await mutations.putAndTrack("playerInputs", structuredClone(record));
    },

    async getPlayerInput(
      sessionId: string,
      formId: string,
    ): Promise<PlayerInputRecord | null> {
      const results = await db.getAllFromIndex("playerInputs", "lookup", [
        sessionId,
        formId,
      ]);
      return results[0] ?? null;
    },

    async listPlayerInputs(sessionId: string): Promise<PlayerInputRecord[]> {
      return db.getAllFromIndex("playerInputs", "sessionId", sessionId);
    },
  };
}
