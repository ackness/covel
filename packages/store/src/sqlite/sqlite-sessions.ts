import { eq } from "drizzle-orm";

import type { DataStore, SessionRecord } from "../types.js";
import { mergeSessionPatch } from "../types.js";
import * as schema from "./schema.js";
import { deleteSqliteSessionCascade } from "./sqlite-session-cascade.js";
import { toJson, toSessionRecord } from "./sqlite-store-mappers.js";
import type { SqliteConnection, SqliteDb } from "./sqlite-types.js";

export type SqliteSessions = Pick<
  DataStore,
  | "createSession"
  | "getSession"
  | "updateSession"
  | "listSessions"
  | "deleteSession"
>;

export function createSqliteSessions(
  sqlite: SqliteConnection,
  db: SqliteDb,
): SqliteSessions {
  return {
    async createSession(session: SessionRecord): Promise<void> {
      db.insert(schema.sessions)
        .values({
          id: session.id,
          worldId: session.worldId ?? null,
          status: session.status,
          turnCount: session.turnCount,
          preGameCompleted: JSON.stringify(session.preGameCompleted ?? []),
          locale: session.locale,
          activePlugins: JSON.stringify(session.activePlugins),
          metadata: session.metadata != null ? toJson(session.metadata) : null,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          runtimeModelOverrides: JSON.stringify(
            session.runtimeModelOverrides ?? {},
          ),
        })
        .run();
    },

    async getSession(id: string): Promise<SessionRecord | null> {
      const row = db
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.id, id))
        .get();
      return row ? toSessionRecord(row) : null;
    },

    async updateSession(
      id: string,
      patch: Parameters<DataStore["updateSession"]>[1],
    ): Promise<void> {
      const rows = db
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.id, id));
      const existingRow = rows.get();
      if (!existingRow) return;
      const mergedSession = mergeSessionPatch(
        toSessionRecord(existingRow),
        patch,
      );
      const values: Record<string, unknown> = {};
      if (patch.status !== undefined) values.status = patch.status;
      if (patch.turnCount !== undefined) values.turnCount = patch.turnCount;
      if (patch.preGameCompleted !== undefined)
        values.preGameCompleted = JSON.stringify(patch.preGameCompleted);
      if (patch.activePlugins !== undefined)
        values.activePlugins = JSON.stringify(patch.activePlugins);
      if ("metadata" in patch || "presetId" in patch) {
        values.metadata =
          mergedSession.metadata != null
            ? toJson(mergedSession.metadata)
            : null;
      }
      if (patch.updatedAt !== undefined) values.updatedAt = patch.updatedAt;
      if ("embeddingModelId" in patch)
        values.embeddingModelId = patch.embeddingModelId ?? null;
      if ("embeddingLockedAt" in patch)
        values.embeddingLockedAt = patch.embeddingLockedAt ?? null;
      if ("runtimeModelOverrides" in patch) {
        values.runtimeModelOverrides = JSON.stringify(
          patch.runtimeModelOverrides ?? {},
        );
      }

      if (Object.keys(values).length > 0) {
        db.update(schema.sessions)
          .set(values)
          .where(eq(schema.sessions.id, id))
          .run();
      }
    },

    async listSessions(): Promise<SessionRecord[]> {
      const rows = db.select().from(schema.sessions).all();
      return rows.map(toSessionRecord);
    },

    async deleteSession(id: string): Promise<void> {
      deleteSqliteSessionCascade(sqlite, id);
    },
  };
}
