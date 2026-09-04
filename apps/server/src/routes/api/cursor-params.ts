/**
 * Shared keyset-cursor query parsing for the paginated read endpoints
 * (`/messages/page`, `/traces/:id/turns/page`). Keeps the `?limit`,
 * opaque `?cursor` contract identical across routes.
 */

import type { Context } from "hono";
import {
  decodePageCursor,
  encodePageCursor,
  type PageCursor,
  type TimeCursor,
} from "@covel/shared";

/** Fallback page size when `?limit` is absent or invalid. */
export const DEFAULT_PAGE_LIMIT = 80;
/** Hard ceiling so a client cannot request an unbounded window. */
export const MAX_PAGE_LIMIT = 500;

export interface CursorQuery {
  readonly ok: true;
  readonly limit: number;
  readonly before?: TimeCursor;
}

export interface InvalidCursorQuery {
  readonly ok: false;
  readonly limit: number;
}

/**
 * Parse `?limit` and an opaque `?cursor` into a bounded page request. Invalid
 * cursor data is reported to the route as a stable client error.
 */
export function parseCursorQuery(
  c: Context,
  defaultLimit: number = DEFAULT_PAGE_LIMIT,
): CursorQuery | InvalidCursorQuery {
  const rawLimit = Number(c.req.query("limit"));
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), MAX_PAGE_LIMIT)
      : defaultLimit;

  const encodedCursor = c.req.query("cursor");
  const before = encodedCursor ? decodePageCursor(encodedCursor) : undefined;
  if (encodedCursor && !before) return { ok: false, limit };

  return { ok: true, limit, before: before ?? undefined };
}

/**
 * The cursor for the next (older) page: the oldest returned row's position, or
 * `null` when the page is short (fewer than `limit` rows ⇒ start of history
 * reached). `items` must be oldest-first, as the store page methods return.
 */
export function nextCursorFrom<T extends { createdAt: string; id: string }>(
  items: readonly T[],
  limit: number,
): PageCursor | null {
  const oldest = items[0];
  return items.length >= limit && oldest
    ? encodePageCursor({ createdAt: oldest.createdAt, id: oldest.id })
    : null;
}
