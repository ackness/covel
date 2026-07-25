import type { TimeCursor } from "@covel/shared";

export type { TimeCursor };

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
 * Keyset page over an append-only log. Rows are returned **oldest-first**.
 * `before` omitted ⇒ the newest `limit` rows (the tail); `before` set ⇒ the
 * `limit` rows immediately older than that position. A `limit <= 0` returns an
 * empty array.
 */
export interface CursorPageOpts {
  readonly limit: number;
  readonly before?: TimeCursor;
}
