/**
 * Pagination options shared by list APIs.
 *
 * Split out of `../types.ts` by domain; re-exported there for compatibility.
 */

export interface PaginationOpts {
  /** Max rows to return. Default varies by method. */
  readonly limit?: number;
  /** Number of rows to skip. Default: 0. */
  readonly offset?: number;
}

/**
 * A stable position in an append-only, time-ordered log, used as a keyset
 * ("cursor") for backward pagination. The `(createdAt, id)` tuple is a *total*
 * order even when many rows share a millisecond `createdAt` (common when a turn
 * commits several proposals at once), so paging by it never skips or repeats a
 * row — unlike a bare `createdAt` cursor.
 */
export interface TimeCursor {
  readonly createdAt: string;
  readonly id: string;
}

/**
 * Keyset page over an append-only log. Rows are returned **oldest-first**.
 * `before` omitted ⇒ the newest `limit` rows (the tail); `before` set ⇒ the
 * `limit` rows immediately older than that position. A `limit <= 0` returns an
 * empty array.
 */
export interface CursorPageOpts {
  readonly limit: number;
  readonly before?: TimeCursor;
}
