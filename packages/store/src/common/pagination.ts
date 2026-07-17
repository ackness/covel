import type { CursorPageOpts, PaginationOpts } from "../types.js";

export function applyPagination<T>(
  items: readonly T[],
  pagination?: PaginationOpts,
): T[] {
  if (!pagination) return [...items];
  const offset = pagination.offset ?? 0;
  const limit = pagination.limit;
  if (limit !== undefined) return items.slice(offset, offset + limit);
  if (offset > 0) return items.slice(offset);
  return [...items];
}

type Keyed = { readonly createdAt: string; readonly id: string };

/**
 * Total order on `(createdAt, id)` — the JS mirror of the SQL keyset order.
 *
 * Uses code-unit `<` (NOT `localeCompare`) so the tie-break matches SQLite's
 * BINARY collation and {@link applyCursorPage}'s own `<` comparison exactly: for
 * ASCII ids (all framework-generated + client-supplied ids in practice), a
 * code-unit compare equals a byte compare. `localeCompare` would order e.g.
 * `"alpha"` before `"Zeta"` while SQLite orders `"Zeta"` first, so memory/idb
 * and the SQL backends would pick DIFFERENT rows for the same same-`createdAt`
 * cursor page — a store-backend-parity bug (skip/duplicate at page boundary).
 */
export function sortByCursorAsc<T extends Keyed>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    return 0;
  });
}

/**
 * Apply a {@link CursorPageOpts} keyset page to rows already sorted ascending
 * by `(createdAt, id)`. Returns oldest-first (the memory/idb counterpart to the
 * SQL `desc … limit … reverse` path). `limit <= 0` ⇒ `[]`.
 */
export function applyCursorPage<T extends Keyed>(
  rowsAscending: readonly T[],
  opts: CursorPageOpts,
): T[] {
  if (opts.limit <= 0) return [];
  const before = opts.before;
  const older = before
    ? rowsAscending.filter(
        (r) =>
          r.createdAt < before.createdAt ||
          (r.createdAt === before.createdAt && r.id < before.id),
      )
    : rowsAscending;
  return older.slice(-opts.limit);
}

/**
 * Forward keyset read over rows already sorted ascending by `(createdAt, id)`:
 * the first `limit` rows strictly after `after` (all rows from the start when
 * `after` is null). The memory/idb counterpart to `cursorAfterWhere`.
 * `limit <= 0` ⇒ `[]`.
 */
export function applyCursorAfter<T extends Keyed>(
  rowsAscending: readonly T[],
  after: { readonly createdAt: string; readonly id: string } | null,
  limit: number,
): T[] {
  if (limit <= 0) return [];
  const newer = after
    ? rowsAscending.filter(
        (r) =>
          r.createdAt > after.createdAt ||
          (r.createdAt === after.createdAt && r.id > after.id),
      )
    : rowsAscending;
  return newer.slice(0, limit);
}
