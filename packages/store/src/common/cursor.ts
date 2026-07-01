/**
 * Keyset ("cursor") pagination helpers for the shared SQL record modules.
 *
 * Both `sql-session-content-records.ts` (messages) and
 * `sql-session-journal-records.ts` (trace events) page an append-only,
 * time-ordered log by the same `(createdAt, id)` tuple, so the WHERE/ORDER
 * construction lives here once. The tuple is a *total* order even when rows
 * share a millisecond `createdAt`, so pages never skip or repeat a row — see
 * {@link CursorPageOpts}.
 *
 * Collation note: the `id` tie-break compares strings with the column's default
 * collation — SQLite `text` is BINARY (byte order), matching the JS backends'
 * code-unit `<` (`sortByCursorAsc`). PostgreSQL `text` uses the database's
 * default collation, which for MIXED-CASE / non-ASCII ids can order differently
 * from byte order. This never bites in practice: every framework-generated id
 * is a lowercase-ASCII UUID (`crypto.randomUUID()`), for which all collations
 * agree. The only way a non-lowercase id enters is a client-supplied
 * `messages/sync` id — if strict byte-order parity for arbitrary ids on PG is
 * ever required, the `id` columns need `COLLATE "C"` (drizzle 0.45 does not
 * model column collation, so it would be a codegen/migration change).
 */

import { and, desc, eq, lt, or } from "drizzle-orm";
import type { Column, SQL } from "drizzle-orm";

import type { CursorPageOpts } from "../records/pagination-records.js";

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
  before?: CursorPageOpts["before"],
): SQL | undefined {
  const base = eq(cols.sessionId, sessionId);
  if (!before) return base;
  const older = or(
    lt(cols.createdAt, before.createdAt),
    and(eq(cols.createdAt, before.createdAt), lt(cols.id, before.id)),
  );
  return and(base, older);
}

/**
 * ORDER BY for a keyset page. Descending so the DB returns the newest window;
 * callers `.reverse()` the rows back to oldest-first.
 */
export function cursorPageOrder(cols: CursorColumns): SQL[] {
  return [desc(cols.createdAt), desc(cols.id)];
}
