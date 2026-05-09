import { and, asc, eq, isNull } from "drizzle-orm";

import type { DataStore, SnapshotRecord, SuspensionRecord } from "../types.js";
import type { PgDb } from "./pg-db.js";
import { toSnapshotRecord, toSuspensionRecord } from "./pg-store-mappers.js";
import * as schema from "./schema.js";

export type PgSnapshotRecords = Pick<
  DataStore,
  | "saveSuspension"
  | "getSuspension"
  | "markSuspensionResolved"
  | "claimSuspension"
  | "listSuspensions"
  | "deleteSuspension"
  | "saveSnapshot"
  | "getSnapshot"
  | "listSnapshots"
  | "deleteSnapshot"
>;

export function createPgSnapshotRecords(getDb: () => PgDb): PgSnapshotRecords {
  return {
    async saveSuspension(record: SuspensionRecord): Promise<void> {
      await getDb()
        .insert(schema.suspensions)
        .values({
          id: record.id,
          sessionId: record.sessionId,
          turnId: record.turnId,
          runtimeId: record.runtimeId,
          pluginId: record.pluginId,
          reason: record.reason,
          resumeSchema: record.resumeSchema as Record<string, unknown>,
          pendingContinuation: record.pendingContinuation as Record<
            string,
            unknown
          >,
          createdAt: record.createdAt,
          resolvedAt: record.resolvedAt ?? null,
        })
        .onConflictDoUpdate({
          target: schema.suspensions.id,
          set: {
            reason: record.reason,
            resumeSchema: record.resumeSchema as Record<string, unknown>,
            pendingContinuation: record.pendingContinuation as Record<
              string,
              unknown
            >,
            resolvedAt: record.resolvedAt ?? null,
          },
        });
    },

    async getSuspension(id: string): Promise<SuspensionRecord | null> {
      const rows = await getDb()
        .select()
        .from(schema.suspensions)
        .where(eq(schema.suspensions.id, id));
      return rows[0] ? toSuspensionRecord(rows[0]) : null;
    },

    async markSuspensionResolved(id: string): Promise<void> {
      await getDb()
        .update(schema.suspensions)
        .set({ resolvedAt: new Date().toISOString() })
        .where(eq(schema.suspensions.id, id));
    },

    async claimSuspension(id: string): Promise<boolean> {
      const rows = await getDb()
        .update(schema.suspensions)
        .set({ resolvedAt: `claimed:${new Date().toISOString()}` })
        .where(
          and(
            eq(schema.suspensions.id, id),
            isNull(schema.suspensions.resolvedAt),
          ),
        )
        .returning({ id: schema.suspensions.id });
      return rows.length === 1;
    },

    async listSuspensions(
      sessionId: string,
    ): Promise<readonly SuspensionRecord[]> {
      const rows = await getDb()
        .select()
        .from(schema.suspensions)
        .where(eq(schema.suspensions.sessionId, sessionId))
        .orderBy(asc(schema.suspensions.createdAt));
      return rows.map(toSuspensionRecord);
    },

    async deleteSuspension(id: string): Promise<void> {
      await getDb()
        .delete(schema.suspensions)
        .where(eq(schema.suspensions.id, id));
    },

    async saveSnapshot(record: SnapshotRecord): Promise<void> {
      await getDb()
        .insert(schema.stateSnapshots)
        .values({
          id: record.id,
          sessionId: record.sessionId,
          turnId: record.turnId,
          kind: record.kind,
          parentId: record.parentId ?? null,
          payload: record.payload as unknown as Record<string, unknown>,
          createdAt: record.createdAt,
        })
        .onConflictDoUpdate({
          target: schema.stateSnapshots.id,
          set: {
            turnId: record.turnId,
            kind: record.kind,
            parentId: record.parentId ?? null,
            payload: record.payload as unknown as Record<string, unknown>,
          },
        });
    },

    async getSnapshot(id: string): Promise<SnapshotRecord | null> {
      const rows = await getDb()
        .select()
        .from(schema.stateSnapshots)
        .where(eq(schema.stateSnapshots.id, id));
      return rows[0] ? toSnapshotRecord(rows[0]) : null;
    },

    async listSnapshots(sessionId: string): Promise<readonly SnapshotRecord[]> {
      const rows = await getDb()
        .select()
        .from(schema.stateSnapshots)
        .where(eq(schema.stateSnapshots.sessionId, sessionId))
        .orderBy(asc(schema.stateSnapshots.createdAt));
      return rows.map(toSnapshotRecord);
    },

    async deleteSnapshot(id: string): Promise<void> {
      await getDb()
        .delete(schema.stateSnapshots)
        .where(eq(schema.stateSnapshots.id, id));
    },
  };
}
