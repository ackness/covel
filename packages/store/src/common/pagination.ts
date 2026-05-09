import type { PaginationOpts } from "../types.js";

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
