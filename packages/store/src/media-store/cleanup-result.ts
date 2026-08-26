import type { MediaAssetRecord, MediaCleanupResult } from "@covel/shared";

/** Reconcile a cleanup plan with candidates that passed the final ref check. */
export function finalizeMediaCleanupResult(
  planned: MediaCleanupResult,
  assets: readonly MediaAssetRecord[],
  deletedIds: readonly string[],
): MediaCleanupResult {
  const deletedSet = new Set(deletedIds);
  const bytesDeleted = assets
    .filter((asset) => deletedSet.has(asset.id))
    .reduce((sum, asset) => sum + asset.size, 0);
  return {
    ...planned,
    retained: planned.scanned - deletedIds.length,
    deleted: deletedIds.length,
    bytesDeleted,
    bytesRetained: planned.totalBytes - bytesDeleted,
    deletedIds: [...deletedIds],
  };
}
