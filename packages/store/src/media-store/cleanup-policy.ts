import type {
  MediaAssetRecord,
  MediaCleanupResult,
  MediaLifecyclePolicy,
} from "@covel/shared";

export function cleanupCandidates(
  assets: readonly MediaAssetRecord[],
  protectedIds: ReadonlySet<string>,
  policy: MediaLifecyclePolicy = {},
): {
  readonly result: MediaCleanupResult;
  readonly idsToDelete: readonly string[];
} {
  const nowMs = policy.now?.getTime() ?? Date.now();
  const protectedSet = new Set(protectedIds);
  const onlyIds = policy.onlyIds ? new Set(policy.onlyIds) : undefined;
  const kept = (id: string): boolean =>
    protectedSet.has(id) || (onlyIds !== undefined && !onlyIds.has(id));
  const sorted = [...assets].sort((a, b) => {
    const byCreated = a.createdAt.localeCompare(b.createdAt);
    return byCreated === 0 ? a.id.localeCompare(b.id) : byCreated;
  });
  const idsToDelete = new Set<string>();
  let currentBytes = sorted.reduce((sum, asset) => sum + asset.size, 0);

  if (typeof policy.maxAgeMs === "number" && policy.maxAgeMs >= 0) {
    const cutoff = nowMs - policy.maxAgeMs;
    for (const asset of sorted) {
      if (kept(asset.id)) continue;
      const created = Date.parse(asset.createdAt);
      if (Number.isFinite(created) && created <= cutoff) {
        idsToDelete.add(asset.id);
        currentBytes -= asset.size;
      }
    }
  }

  if (
    typeof policy.keepRecentBytes === "number" &&
    policy.keepRecentBytes >= 0
  ) {
    let recentBytes = 0;
    for (const asset of [...sorted].reverse()) {
      if (kept(asset.id) || idsToDelete.has(asset.id)) continue;
      recentBytes += asset.size;
      if (recentBytes > policy.keepRecentBytes) {
        idsToDelete.add(asset.id);
        currentBytes -= asset.size;
      }
    }
  }

  if (typeof policy.maxBytes === "number" && policy.maxBytes >= 0) {
    for (const asset of sorted) {
      if (currentBytes <= policy.maxBytes) break;
      if (kept(asset.id) || idsToDelete.has(asset.id)) continue;
      idsToDelete.add(asset.id);
      currentBytes -= asset.size;
    }
  }

  const deletedIds = [...idsToDelete];
  const deletedSet = new Set(deletedIds);
  const totalBytes = assets.reduce((sum, asset) => sum + asset.size, 0);
  const bytesDeleted = assets
    .filter((asset) => deletedSet.has(asset.id))
    .reduce((sum, asset) => sum + asset.size, 0);

  return {
    idsToDelete: deletedIds,
    result: {
      scanned: assets.length,
      protected: assets.filter((asset) => protectedSet.has(asset.id)).length,
      retained: assets.length - deletedIds.length,
      deleted: deletedIds.length,
      totalBytes,
      bytesDeleted,
      bytesRetained: totalBytes - bytesDeleted,
      protectedIds: [...protectedSet].sort(),
      deletedIds,
    },
  };
}
