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
