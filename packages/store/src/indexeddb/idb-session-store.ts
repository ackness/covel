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

  async function cascadeByIndex(
    storeName: IdbStoreName,
    sessionId: string,
  ): Promise<void> {
    const rows = (await db.getAllFromIndex(
      storeName,
      "sessionId",
      sessionId,
    )) as Array<{ id: string }>;
    for (const row of rows) {
      await mutations.deleteAndTrack(storeName, row.id);
    }
  }

  async function cascadeByFilter(
    storeName: IdbStoreName,
    sessionId: string,
  ): Promise<void> {
    const all = (await db.getAll(storeName)) as Array<{
      id: string;
      sessionId: string;
    }>;
    for (const row of all) {
      if (row.sessionId === sessionId) {
        await mutations.deleteAndTrack(storeName, row.id);
      }
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
      await cascadeByIndex("turnResults", id);
      await cascadeByFilter("runtimeResults", id);
      await cascadeByIndex("toolCalls", id);
      await cascadeByIndex("stateSchemas", id);
      await cascadeByIndex("stateEntries", id);
      await cascadeByIndex("stateChanges", id);
      await cascadeByIndex("events", id);
      await cascadeByIndex("approvals", id);
      await cascadeByIndex("messages", id);
      await cascadeByIndex("characters", id);
      await cascadeByIndex("traceEvents", id);
      await cascadeByIndex("turnMessages", id);
      await cascadeByIndex("playerInputs", id);
      await cascadeByIndex("working_memory", id);
      await cascadeByIndex("sessionSummaries", id);
      await cascadeByIndex("suspensions", id);
      await cascadeByIndex("state_snapshots", id);
      await cascadeByIndex("lorebook_entries", id);
      await cascadeByIndex("runtime_outputs", id);
      await cascadeByIndex("interaction_records", id);
      await cascadeByFilter("pluginConfigs", id);
      await cascadeByFilter("plugin_data", id);
      await cascadeByIndex("world_data_import_ledger", id);
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
