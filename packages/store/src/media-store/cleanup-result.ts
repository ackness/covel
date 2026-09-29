import type {
  MediaAssetRecord,
  MediaCleanupResult,
  MediaRefRecord,
} from "@covel/shared";

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

/** Include current claims in dry-run plans as well as the final deletion gate. */
export function claimedMediaIds(
  protectedIds: ReadonlySet<string>,
  assets: readonly MediaAssetRecord[],
  refs: readonly MediaRefRecord[],
): ReadonlySet<string> {
  return new Set([
    ...protectedIds,
    ...assets
      .filter((asset) => asset.ownerSessionId !== null)
      .map((asset) => asset.id),
    ...refs.map((ref) => ref.mediaId),
  ]);
}
