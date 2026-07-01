/**
 * Shared keyset-cursor query parsing for the paginated read endpoints
 * (`/messages/page`, `/traces/:id/turns/page`). Keeps the `?limit`,
 * `?before_created_at`, `?before_id` contract identical across routes.
 */

import type { Context } from "hono";
import type { TimeCursor } from "@covel/shared";

/** Fallback page size when `?limit` is absent or invalid. */
export const DEFAULT_PAGE_LIMIT = 80;
/** Hard ceiling so a client cannot request an unbounded window. */
export const MAX_PAGE_LIMIT = 500;

export interface CursorQuery {
  readonly limit: number;
  readonly before?: TimeCursor;
}

/**
 * Parse `?limit`, `?before_created_at`, `?before_id` into a bounded page
 * request. `limit` is clamped to `[1, MAX_PAGE_LIMIT]`. A cursor is only
 * returned when BOTH `before_created_at` and `before_id` are present — the
 * tuple is meaningless without its tie-break half.
 */
export function parseCursorQuery(
  c: Context,
  defaultLimit: number = DEFAULT_PAGE_LIMIT,
): CursorQuery {
  const rawLimit = Number(c.req.query("limit"));
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), MAX_PAGE_LIMIT)
      : defaultLimit;

  const createdAt = c.req.query("before_created_at");
  const id = c.req.query("before_id");
  const before = createdAt && id ? { createdAt, id } : undefined;

  return { limit, before };
}

/**
 * The cursor for the next (older) page: the oldest returned row's position, or
 * `null` when the page is short (fewer than `limit` rows ⇒ start of history
 * reached). `items` must be oldest-first, as the store page methods return.
 */
export function nextCursorFrom<T extends { createdAt: string; id: string }>(
  items: readonly T[],
  limit: number,
): TimeCursor | null {
  const oldest = items[0];
  return items.length >= limit && oldest
    ? { createdAt: oldest.createdAt, id: oldest.id }
    : null;
}
