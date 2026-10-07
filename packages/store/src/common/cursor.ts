/**
 * Keyset ("cursor") pagination helpers for the shared SQL record modules.
 *
 * Two kinds of log are paged here:
 *
 *  - A log ordered by `(createdAt, id)` (snapshots, the forward read of turn
 *    messages). The tuple is a *total* order even when rows share a
 *    millisecond `createdAt`, so pages never skip or repeat a row — see
 *    {@link CursorPageOpts}.
 *  - A log that keeps the order its rows were written in (chat messages, trace
 *    events), ordered by `(createdAt, seq, id)` — see {@link WriteOrderTable}.
 *
 * The `id` of either order is compared byte by byte on every backend
 * (`SqlRunner.byteOrder`): an ID a client supplied can be mixed-case or
 * non-ASCII, and PostgreSQL's database collation would place it elsewhere than
 * SQLite and MemoryStore do.
 */

import { and, asc, desc, eq, gt, lt, or, sql } from "drizzle-orm";
import type { Column, SQL, Table } from "drizzle-orm";

import type { CursorPageOpts } from "../records/pagination-records.js";

/** A text column compared byte by byte; see `SqlRunner.byteOrder`. */
export type ByteOrder = (column: Column) => SQL;

/** The three columns a keyset page reads from. */
export interface CursorColumns {
  readonly sessionId: Column;
  readonly createdAt: Column;
  readonly id: Column;
}

/**
 * WHERE for a keyset page: `sessionId = ?` plus, when a cursor is supplied,
 * the strict `(createdAt, id) < (cursor.createdAt, cursor.id)` tuple predicate.
 */
export function cursorPageWhere(
  cols: CursorColumns,
  sessionId: string,
  before: CursorPageOpts["before"],
  byteOrder: ByteOrder,
): SQL | undefined {
  const base = eq(cols.sessionId, sessionId);
  if (!before) return base;
  const older = or(
    lt(cols.createdAt, before.createdAt),
    and(
      eq(cols.createdAt, before.createdAt),
      lt(byteOrder(cols.id), before.id),
    ),
  );
  return and(base, older);
}

/**
 * ORDER BY for a keyset page. Descending so the DB returns the newest window;
 * callers `.reverse()` the rows back to oldest-first.
 */
export function cursorPageOrder(
  cols: CursorColumns,
  byteOrder: ByteOrder,
): SQL[] {
  return [desc(cols.createdAt), desc(byteOrder(cols.id))];
}

/**
 * WHERE for a forward keyset read: `sessionId = ?` plus, when a cursor is
 * supplied, the strict `(createdAt, id) > (after.createdAt, after.id)` tuple
 * predicate — the mirror of {@link cursorPageWhere} for oldest-first
 * consumers that walk the log incrementally (vector-ingest's recall cursor).
 */
export function cursorAfterWhere(
  cols: CursorColumns,
  sessionId: string,
  after: { readonly createdAt: string; readonly id: string } | null,
  byteOrder: ByteOrder,
): SQL | undefined {
  const base = eq(cols.sessionId, sessionId);
  if (!after) return base;
  const newer = or(
    gt(cols.createdAt, after.createdAt),
    and(eq(cols.createdAt, after.createdAt), gt(byteOrder(cols.id), after.id)),
  );
  return and(base, newer);
}

/** ORDER BY for a forward keyset read — oldest-first, no reverse needed. */
export function cursorAfterOrder(
  cols: CursorColumns,
  byteOrder: ByteOrder,
): SQL[] {
  return [asc(cols.createdAt), asc(byteOrder(cols.id))];
}

/**
 * A log that keeps the order its rows were written in.
 *
 * `createdAt` has millisecond precision and the rows of one commit share it,
 * so `(createdAt, id)` lists them in the order of their random IDs. The store
 * numbers rows as it inserts them (`seq`), and the log is ordered by
 * `(createdAt, seq, id)`. SQLite numbers within one session and `createdAt`
 * under its serialized write boundary; PostgreSQL uses a per-table sequence
 * so simultaneous connections cannot allocate the same number.
 *
 * `seq` is not part of a record. A copy of the log — a fork, a checkpoint
 * import — that is inserted in list order is numbered in that order again.
 */
export type WriteOrderTable = Table & CursorColumns & { readonly seq: Column };

/**
 * SQLite's `seq` of a row about to be inserted: one more than the highest of its
 * session and `createdAt`. A subquery of the INSERT itself, so the number is
 * taken in the same statement that writes the row.
 */
export function nextWriteOrderSeq(
  table: WriteOrderTable,
  row: { readonly sessionId: string; readonly createdAt: string },
): SQL {
  return sql`(select coalesce(max(${table.seq}), -1) + 1 from ${table} where ${table.sessionId} = ${row.sessionId} and ${table.createdAt} = ${row.createdAt})`;
}

/** ORDER BY of a write-order log, oldest-first. */
export function writeOrderAsc(
  table: WriteOrderTable,
  byteOrder: ByteOrder,
): SQL[] {
  return [asc(table.createdAt), asc(table.seq), asc(byteOrder(table.id))];
}

/**
 * ORDER BY for a keyset page of a write-order log. Descending, like
 * {@link cursorPageOrder}; callers reverse the rows.
 */
export function writeOrderPageOrder(
  table: WriteOrderTable,
  byteOrder: ByteOrder,
): SQL[] {
  return [desc(table.createdAt), desc(table.seq), desc(byteOrder(table.id))];
}

/**
 * WHERE for a keyset page of a write-order log: the rows strictly before the
 * cursor in `(createdAt, seq, id)`.
 *
 * A cursor carries `(createdAt, id)` only, so the `seq` it stands for is read
 * from the row it names. When no row of the session has that `id` and
 * `createdAt`, the subquery is NULL and no row of the cursor's millisecond
 * matches: the page holds rows of an earlier `createdAt` only.
 */
export function writeOrderPageWhere(
  table: WriteOrderTable,
  sessionId: string,
  before: CursorPageOpts["before"],
  byteOrder: ByteOrder,
): SQL | undefined {
  const base = eq(table.sessionId, sessionId);
  if (!before) return base;
  const cursorSeq = sql`(select ${table.seq} from ${table} where ${table.sessionId} = ${sessionId} and ${table.id} = ${before.id} and ${table.createdAt} = ${before.createdAt})`;
  const older = or(
    lt(table.createdAt, before.createdAt),
    and(
      eq(table.createdAt, before.createdAt),
      or(
        lt(table.seq, cursorSeq),
        and(eq(table.seq, cursorSeq), lt(byteOrder(table.id), before.id)),
      ),
    ),
  );
  return and(base, older);
}
