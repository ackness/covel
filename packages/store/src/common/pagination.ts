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

/** Total order on `(createdAt, id)` — the JS mirror of the SQL keyset order. */
export function sortByCursorAsc<T extends Keyed>(rows: readonly T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
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
