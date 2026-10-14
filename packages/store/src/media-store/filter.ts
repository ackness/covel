import type { MediaAssetRecord } from "@covel/shared";

/**
 * Final metadata comparison of listByMetadata, shared by every media backend
 * (memory/sqlite/pg) so they agree by construction. Each backend first reads
 * only the session's own assets (SQL: `owner_session_id = ?` on the owner
 * index); this keeps the exact JS comparison on that small set.
 *
 * A `filter` value of `undefined` matches both a missing key and a key
 * explicitly stored as `undefined` (`meta[k] === v` reads `undefined` either
 * way). Only primitive values compare meaningfully — objects/arrays never
 * match since `===` is reference equality.
 */
export function filterAssetsByMetadata(
  assets: readonly MediaAssetRecord[],
  sessionId: string,
  filter: Readonly<Record<string, unknown>>,
): readonly MediaAssetRecord[] {
  return assets.filter((asset) => {
    if (asset.ownerSessionId !== sessionId) return false;
    const meta = asset.meta ?? {};
    return Object.entries(filter).every(([k, v]) => meta[k] === v);
  });
}
