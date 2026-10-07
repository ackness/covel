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

/**
 * Order of two strings by their UTF-8 bytes, which is the order of their code
 * points: what SQLite's BINARY collation and PostgreSQL's `collate "C"` give.
 * `<` compares UTF-16 code units instead, and puts a character above U+FFFF
 * (an emoji) before U+E000–U+FFFF (a fullwidth letter).
 */
export function compareByteOrder(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x === y) continue;
    // A surrogate is half of a code point above U+FFFF.
    const xSurrogate = x >= 0xd800 && x <= 0xdfff;
    const ySurrogate = y >= 0xd800 && y <= 0xdfff;
    if (xSurrogate !== ySurrogate) return xSurrogate ? 1 : -1;
    return x < y ? -1 : 1;
  }
  return a.length - b.length;
}

type Keyed = { readonly createdAt: string; readonly id: string };

/**
 * Total order on `(createdAt, id)` — the JS mirror of the SQL keyset order
 * (`cursorPageOrder` / `cursorAfterOrder`).
 *
 * The `id` tie-break is {@link compareByteOrder}, the order the SQL backends
 * give it (`SqlRunner.byteOrder`). `localeCompare` would order e.g. `"alpha"`
 * before `"Zeta"` while SQLite orders `"Zeta"` first, so MemoryStore and the
 * SQL backends would pick DIFFERENT rows for the same same-`createdAt` cursor
 * page — a store-backend-parity bug (skip/duplicate at page boundary).
 */
export function sortByCursorAsc<T extends Keyed>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    // A timestamp is ASCII: `<` orders it as its bytes do.
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return compareByteOrder(a.id, b.id);
  });
}

/**
 * Apply a {@link CursorPageOpts} keyset page to rows already sorted ascending
 * by `(createdAt, id)`. Returns oldest-first (the MemoryStore counterpart to
 * the SQL `desc … limit … reverse` path). `limit <= 0` ⇒ `[]`.
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
          (r.createdAt === before.createdAt &&
            compareByteOrder(r.id, before.id) < 0),
      )
    : rowsAscending;
  return older.slice(-opts.limit);
}

/**
 * Forward keyset read over rows already sorted ascending by `(createdAt, id)`:
 * the first `limit` rows strictly after `after` (all rows from the start when
 * `after` is null). The MemoryStore counterpart to `cursorAfterWhere`.
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
          (r.createdAt === after.createdAt &&
            compareByteOrder(r.id, after.id) > 0),
      )
    : rowsAscending;
  return newer.slice(0, limit);
}

/**
 * The rows of a write-order log, oldest-first — the JS mirror of
 * `writeOrderAsc` in `cursor.ts`. MemoryStore appends such a log to an array,
 * so a row's place in the array is its `seq`: pass the rows as the array holds
 * them. The sort is stable, and rows of one `createdAt` keep that order.
 */
export function sortByWriteOrder<T extends { readonly createdAt: string }>(
  rowsAsWritten: readonly T[],
): T[] {
  return [...rowsAsWritten].sort((a, b) =>
    a.createdAt === b.createdAt ? 0 : a.createdAt < b.createdAt ? -1 : 1,
  );
}

/**
 * Apply a {@link CursorPageOpts} keyset page to rows from
 * {@link sortByWriteOrder} — the JS mirror of `writeOrderPageWhere`. The
 * cursor names a row by `id` and `createdAt`; rows of that millisecond count
 * as older when they come before it. When no row matches the cursor, only rows
 * of an earlier `createdAt` are older. `limit <= 0` ⇒ `[]`.
 */
export function applyWriteOrderPage<T extends Keyed>(
  rowsAscending: readonly T[],
  opts: CursorPageOpts,
): T[] {
  if (opts.limit <= 0) return [];
  const before = opts.before;
  if (!before) return rowsAscending.slice(-opts.limit);
  const cursorAt = rowsAscending.findIndex(
    (r) => r.id === before.id && r.createdAt === before.createdAt,
  );
  const older = rowsAscending.filter(
    (r, index) =>
      r.createdAt < before.createdAt ||
      (r.createdAt === before.createdAt && cursorAt !== -1 && index < cursorAt),
  );
  return older.slice(-opts.limit);
}
