import { eq } from "drizzle-orm";

import type { DataStore, SessionRecord } from "../types.js";
import { mergeSessionPatch } from "../types.js";
import type { PgDb } from "./pg-db.js";
import { deletePgSessionCascade } from "./pg-session-cascade.js";
import { toSessionRecord } from "./pg-store-mappers.js";
import * as schema from "./schema.js";

export type PgSessionRecords = Pick<
  DataStore,
  | "createSession"
  | "getSession"
  | "updateSession"
  | "listSessions"
  | "deleteSession"
>;

export function createPgSessionRecords(getDb: () => PgDb): PgSessionRecords {
  return {
    async createSession(session: SessionRecord): Promise<void> {
      await getDb()
        .insert(schema.sessions)
        .values({
          id: session.id,
          worldId: session.worldId ?? null,
          status: session.status,
          turnCount: session.turnCount,
          preGameCompleted: session.preGameCompleted as string[],
          locale: session.locale,
          activePlugins: session.activePlugins as string[],
          metadata: session.metadata ?? null,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          runtimeModelOverrides: (session.runtimeModelOverrides ??
            {}) as Record<string, string>,
        });
    },

    async getSession(id: string): Promise<SessionRecord | null> {
      const rows = await getDb()
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.id, id));
      return rows.length > 0 ? toSessionRecord(rows[0]) : null;
    },

    async updateSession(
      id: string,
      patch: Partial<
        Pick<
          SessionRecord,
          | "status"
          | "turnCount"
          | "preGameCompleted"
          | "activePlugins"
          | "presetId"
          | "updatedAt"
          | "metadata"
          | "embeddingModelId"
          | "embeddingLockedAt"
          | "runtimeModelOverrides"
        >
      >,
    ): Promise<void> {
      const existingRows = await getDb()
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.id, id));
      if (!existingRows[0]) return;

      const mergedSession = mergeSessionPatch(
        toSessionRecord(existingRows[0]),
        patch,
      );
      const values: Record<string, unknown> = {};
      if (patch.status !== undefined) values.status = patch.status;
      if (patch.turnCount !== undefined) values.turnCount = patch.turnCount;
      if (patch.preGameCompleted !== undefined)
        values.preGameCompleted = patch.preGameCompleted as string[];
      if (patch.activePlugins !== undefined)
        values.activePlugins = patch.activePlugins as string[];
      if ("metadata" in patch || "presetId" in patch) {
        values.metadata = mergedSession.metadata ?? null;
      }
      if (patch.updatedAt !== undefined) values.updatedAt = patch.updatedAt;
      if ("embeddingModelId" in patch)
        values.embeddingModelId = patch.embeddingModelId ?? null;
      if ("embeddingLockedAt" in patch)
        values.embeddingLockedAt = patch.embeddingLockedAt ?? null;
      if ("runtimeModelOverrides" in patch) {
        values.runtimeModelOverrides = (patch.runtimeModelOverrides ??
          {}) as Record<string, string>;
      }

      if (Object.keys(values).length > 0) {
        await getDb()
          .update(schema.sessions)
          .set(values)
          .where(eq(schema.sessions.id, id));
      }
    },

    async listSessions(): Promise<SessionRecord[]> {
      const rows = await getDb().select().from(schema.sessions);
      return rows.map(toSessionRecord);
    },

    async deleteSession(id: string): Promise<void> {
      await getDb().transaction(async (tx) => {
        await deletePgSessionCascade(tx, id);
      });
    },
  };
}
