import { SESSION_SCOPED_TABLES } from "../table-registry.js";
import {
  mergeSessionPatch,
  normalizeSessionRecord,
  type CharacterRecord,
  type SessionRecord,
} from "../types.js";
import type { IdbStoreName } from "./idb-db.js";
import type { IdbStoreContext, IdbStoreSlice } from "./idb-context.js";

export function createIdbSessionStore(ctx: IdbStoreContext): IdbStoreSlice {
  const { db, mutations } = ctx;

  /**
   * Delete every row of `storeName` owned by `sessionId`. Uses the store's
   * `sessionId` index when it has one; otherwise falls back to a full scan
   * filtered on the `sessionId` property (composite-index stores such as
   * `runtimeResults` and `plugin_data` have no standalone `sessionId` index).
   */
  async function cascadeSession(
    storeName: IdbStoreName,
    sessionId: string,
  ): Promise<void> {
    const hasSessionIdIndex = db
      .transaction(storeName)
      .store.indexNames.contains("sessionId");
    const rows = hasSessionIdIndex
      ? ((await db.getAllFromIndex(
          storeName,
          "sessionId",
          sessionId,
        )) as Array<{
          id: string;
        }>)
      : (
          (await db.getAll(storeName)) as Array<{
            id: string;
            sessionId: string;
          }>
        ).filter((row) => row.sessionId === sessionId);
    for (const row of rows) {
      await mutations.deleteAndTrack(storeName, row.id);
    }
  }

  return {
    async createSession(session: SessionRecord): Promise<void> {
      await mutations.putAndTrack(
        "sessions",
        structuredClone(normalizeSessionRecord(session)),
      );
    },

    async getSession(id: string): Promise<SessionRecord | null> {
      const session = (await db.get("sessions", id)) ?? null;
      return session ? normalizeSessionRecord(session) : null;
    },

    async updateSession(id, patch): Promise<void> {
      const existing = await db.get("sessions", id);
      if (!existing) return;
      await mutations.putAndTrack(
        "sessions",
        mergeSessionPatch(existing, patch),
      );
    },

    async listSessions(): Promise<SessionRecord[]> {
      return (await db.getAll("sessions")).map(normalizeSessionRecord);
    },

    async deleteSession(id: string): Promise<void> {
      // Cascade is derived from the registry — adding a session-scoped table
      // there extends this delete automatically, matching the SQL/Memory
      // backends and closing the historical IDB drift gap.
      for (const { idbStore } of SESSION_SCOPED_TABLES) {
        await cascadeSession(idbStore, id);
      }
      // `state_snapshot_metadata` is an IDB-only pagination sidecar (no SQL
      // table, so it is intentionally absent from SESSION_SCOPED_TABLES);
      // clean it explicitly.
      await cascadeSession("state_snapshot_metadata", id);
      await mutations.deleteAndTrack("sessions", id);
    },

    async upsertCharacter(record: CharacterRecord): Promise<void> {
      await mutations.putAndTrack("characters", structuredClone(record));
    },

    async listCharacters(sessionId: string): Promise<CharacterRecord[]> {
      return db.getAllFromIndex("characters", "sessionId", sessionId);
    },

    async deleteCharacter(sessionId: string, id: string): Promise<void> {
      const existing = (await db.get("characters", id)) as
        | CharacterRecord
        | undefined;
      if (existing?.sessionId === sessionId) {
        await mutations.deleteAndTrack("characters", id);
      }
    },
  };
}
