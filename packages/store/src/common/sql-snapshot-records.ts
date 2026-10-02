/**
 * Backend-agnostic snapshot + suspension record queries, shared by the
 * PostgreSQL and SQLite backends.
 *
 * Previously the SQLite backend persisted these two domains through raw
 * `sqlite.prepare(...)` statements (the last hand-written SQL in the store)
 * while PG already used Drizzle. Both expressed the SAME columns, the SAME
 * `ON CONFLICT(id) DO UPDATE SET` column set, and the SAME JSON gateway
 * (SQLite `toJson` ↔ PG passthrough). This module collapses them onto the
 * single {@link SqlRunner} surface: the upsert column sets come from the shared
 * value builders ({@link InsertValueBuilders}), reads go through the canonical
 * {@link toSnapshotRecord}/{@link toSuspensionRecord} mappers + a {@link JsonReader},
 * and `claimSuspension`'s atomic compare-and-swap is expressed via the
 * {@link SqlRunner.updateReturningCount} primitive (PG `RETURNING`, SQLite
 * `changes`).
 */

import { and, asc, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Column, Table } from "drizzle-orm";

import { cursorPageOrder, cursorPageWhere } from "./cursor.js";
import type { InsertValueBuilders } from "./insert-values.js";
import type { JsonReader } from "./mappers.js";
import { toSnapshotRecord, toSuspensionRecord } from "./mappers.js";
import type { SnapshotRow, SuspensionRow } from "./mappers/snapshot-mappers.js";
import { requireSnapshotPayload } from "./mappers/snapshot-mappers.js";
import type { SqlRunner } from "./sql-runner.js";
import { SessionRecordScopeConflictError } from "../errors.js";
import type {
  CursorPageOpts,
  DataStore,
  SnapshotMetadata,
  SnapshotKind,
  SnapshotRecord,
  SuspensionRecord,
} from "../types.js";

type StateSnapshotsTable = Table & {
  id: Column;
  sessionId: Column;
  turnId: Column;
  kind: Column;
  parentId: Column;
  payload: Column;
  createdAt: Column;
};

/** Projected row for the payload-free metadata page. */
interface SnapshotMetaRow {
  id: string;
  sessionId: string;
  turnId: string;
  kind: string;
  parentId: string | null;
  createdAt: string;
  size: number;
}
type SuspensionsTable = Table & {
  id: Column;
  sessionId: Column;
  createdAt: Column;
  resolvedAt: Column;
};

export interface SqlSnapshotTables {
  readonly stateSnapshots: StateSnapshotsTable;
  readonly suspensions: SuspensionsTable;
}

export interface SqlSnapshotRecordsDeps {
  readonly runner: SqlRunner;
  readonly tables: SqlSnapshotTables;
  readonly json: JsonReader;
  readonly values: Pick<
    InsertValueBuilders,
    | "snapshotInsert"
    | "snapshotUpdate"
    | "suspensionInsert"
    | "suspensionUpdate"
  >;
}

export type SqlSnapshotRecords = Pick<
  DataStore,
  | "saveSnapshot"
  | "getSnapshot"
  | "listSnapshots"
  | "listSnapshotsPage"
  | "pruneAutoSnapshots"
  | "saveSuspension"
  | "getSuspension"
  | "markSuspensionResolved"
  | "claimSuspension"
  | "listSuspensions"
  | "deleteSuspension"
  | "deleteExpiredSuspensions"
>;

export function createSqlSnapshotRecords(
  deps: SqlSnapshotRecordsDeps,
): SqlSnapshotRecords {
  const { runner, tables, json, values } = deps;
  const { stateSnapshots, suspensions } = tables;

  return {
    // ── Snapshots ────────────────────────────────────────────────
    async saveSnapshot(record: SnapshotRecord): Promise<void> {
      requireSnapshotPayload(record.payload);
      await runner.insert(stateSnapshots, values.snapshotInsert(record), {
        target: stateSnapshots.id,
        set: values.snapshotUpdate(record),
        // The unique-id conflict and session check are one statement, so a
        // concurrent first insert cannot bind this id to another session.
        setWhere: eq(stateSnapshots.sessionId, record.sessionId),
        errorOnSkipped: new SessionRecordScopeConflictError(
          "snapshot",
          record.id,
        ),
      });
    },

    async getSnapshot(id: string): Promise<SnapshotRecord | null> {
      const row = await runner.selectFirst<SnapshotRow>(stateSnapshots, {
        where: eq(stateSnapshots.id, id),
      });
      return row ? toSnapshotRecord(row, json) : null;
    },

    async listSnapshots(sessionId: string): Promise<readonly SnapshotRecord[]> {
      const rows = await runner.select<SnapshotRow>(stateSnapshots, {
        where: eq(stateSnapshots.sessionId, sessionId),
        orderBy: [asc(stateSnapshots.createdAt)],
      });
      return rows.map((row) => toSnapshotRecord(row, json));
    },

    async listSnapshotsPage(
      sessionId: string,
      opts: CursorPageOpts,
    ): Promise<readonly SnapshotMetadata[]> {
      if (opts.limit <= 0) return [];
      // Partial select: the payload column is neither transferred nor
      // deserialized. `size` is computed in-SQL via `length(cast(payload as
      // text))` — valid on both SQLite (payload is TEXT, cast is a no-op) and
      // PostgreSQL (jsonb → its canonical text form). Keyset `(createdAt, id)`
      // window, newest-first, reversed to oldest-first (see cursorPageOrder).
      const rows = await runner.select<SnapshotMetaRow>(stateSnapshots, {
        columns: {
          id: stateSnapshots.id,
          sessionId: stateSnapshots.sessionId,
          turnId: stateSnapshots.turnId,
          kind: stateSnapshots.kind,
          parentId: stateSnapshots.parentId,
          createdAt: stateSnapshots.createdAt,
          size: sql<number>`length(cast(${stateSnapshots.payload} as text))`,
        },
        where: cursorPageWhere(stateSnapshots, sessionId, opts.before),
        orderBy: cursorPageOrder(stateSnapshots),
        limit: opts.limit,
      });
      return rows.reverse().map((row) => ({
        id: row.id,
        sessionId: row.sessionId,
        turnId: row.turnId,
        kind: row.kind as SnapshotKind,
        ...(row.parentId != null ? { parentId: row.parentId } : {}),
        createdAt: row.createdAt,
        size: Number(row.size),
      }));
    },

    async pruneAutoSnapshots(sessionId: string, keep: number): Promise<number> {
      const autos = await runner.select<{ id: string }>(stateSnapshots, {
        columns: { id: stateSnapshots.id },
        where: and(
          eq(stateSnapshots.sessionId, sessionId),
          eq(stateSnapshots.kind, "auto"),
        ),
        orderBy: [desc(stateSnapshots.createdAt), desc(stateSnapshots.id)],
      });
      const candidates = autos.slice(Math.max(0, keep)).map((row) => row.id);
      if (candidates.length === 0) return 0;
      const referenced = new Set(
        (
          await runner.select<{ parentId: string | null }>(stateSnapshots, {
            columns: { parentId: stateSnapshots.parentId },
            where: inArray(stateSnapshots.parentId, candidates),
          })
        ).flatMap((row) => (row.parentId != null ? [row.parentId] : [])),
      );
      const doomed = candidates.filter((id) => !referenced.has(id));
      if (doomed.length === 0) return 0;
      await runner.delete(stateSnapshots, inArray(stateSnapshots.id, doomed));
      return doomed.length;
    },

    // ── Suspensions ──────────────────────────────────────────────
    async saveSuspension(record: SuspensionRecord): Promise<void> {
      await runner.insert(suspensions, values.suspensionInsert(record), {
        target: suspensions.id,
        set: values.suspensionUpdate(record),
        setWhere: eq(suspensions.sessionId, record.sessionId),
        errorOnSkipped: new SessionRecordScopeConflictError(
          "suspension",
          record.id,
        ),
      });
    },

    async getSuspension(id: string): Promise<SuspensionRecord | null> {
      const row = await runner.selectFirst<SuspensionRow>(suspensions, {
        where: eq(suspensions.id, id),
      });
      return row ? toSuspensionRecord(row, json) : null;
    },

    async markSuspensionResolved(id: string): Promise<void> {
      await runner.update(
        suspensions,
        { resolvedAt: new Date().toISOString() },
        eq(suspensions.id, id),
      );
    },

    async claimSuspension(id: string): Promise<boolean> {
      // Atomic compare-and-swap: a single serialized UPDATE per dialect means
      // two concurrent claims cannot both observe an affected count of 1.
      const affected = await runner.updateReturningCount(
        suspensions,
        { resolvedAt: `claimed:${new Date().toISOString()}` },
        and(eq(suspensions.id, id), isNull(suspensions.resolvedAt)),
      );
      return affected === 1;
    },

    async listSuspensions(
      sessionId: string,
    ): Promise<readonly SuspensionRecord[]> {
      const rows = await runner.select<SuspensionRow>(suspensions, {
        where: eq(suspensions.sessionId, sessionId),
        orderBy: [asc(suspensions.createdAt)],
      });
      return rows.map((row) => toSuspensionRecord(row, json));
    },

    async deleteSuspension(id: string): Promise<void> {
      await runner.delete(suspensions, eq(suspensions.id, id));
    },

    async deleteExpiredSuspensions(olderThanIso: string): Promise<number> {
      // Unresolved-only: `resolvedAt IS NULL` reuses the same predicate
      // `claimSuspension` relies on, so claimed (`claimed:<iso>`) and resolved
      // records are excluded. `SqlRunner.delete` returns void, so the count
      // comes from a prior select — acceptable for a best-effort sweep run
      // serially; a concurrent claim between select and delete only skews the
      // returned count, never deletes a claimed/resolved row.
      const where = and(
        isNull(suspensions.resolvedAt),
        lt(suspensions.createdAt, olderThanIso),
      );
      const rows = await runner.select<SuspensionRow>(suspensions, { where });
      if (rows.length === 0) return 0;
      await runner.delete(suspensions, where);
      return rows.length;
    },
  };
}
