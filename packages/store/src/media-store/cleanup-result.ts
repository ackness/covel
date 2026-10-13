import type {
  MediaAssetRecord,
  MediaCleanupResult,
  MediaLifecyclePolicy,
  MediaRefRecord,
} from "@covel/shared";
import { cleanupCandidates } from "./cleanup-policy.js";

/** Reconcile a cleanup plan with candidates that passed the final ref check. */
export function finalizeMediaCleanupResult(
  planned: MediaCleanupResult,
  assets: readonly MediaAssetRecord[],
  deletedIds: readonly string[],
  expiredRefs: readonly MediaRefRecord[],
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
    expiredRefs: [...expiredRefs],
  };
}

/**
 * References that `policy.expireRefs` releases: held under the given session
 * ID prefix and created no later than `now - maxAgeMs`.
 */
export function expiredMediaRefs(
  refs: readonly MediaRefRecord[],
  policy: MediaLifecyclePolicy = {},
): readonly MediaRefRecord[] {
  const expiry = policy.expireRefs;
  if (!expiry) return [];
  // No session ID contains a colon, so such a prefix never names a session.
  if (!expiry.sessionIdPrefix.includes(":"))
    throw new Error("expireRefs.sessionIdPrefix must contain a colon");
  if (!Number.isFinite(expiry.maxAgeMs) || expiry.maxAgeMs < 0)
    throw new Error("expireRefs.maxAgeMs must be a non-negative number");
  const cutoff = (policy.now?.getTime() ?? Date.now()) - expiry.maxAgeMs;
  return refs.filter((ref) => {
    if (!ref.sessionId.startsWith(expiry.sessionIdPrefix)) return false;
    // A reference without a readable creation time is kept.
    const created = Date.parse(ref.createdAt);
    return Number.isFinite(created) && created <= cutoff;
  });
}

/**
 * Plan a cleanup from one inventory. Current claims protect their assets in a
 * dry run as well as at the final deletion gate; an expired reference is no
 * claim, so the plan shows what its release frees.
 */
export function planMediaCleanup(
  assets: readonly MediaAssetRecord[],
  refs: readonly MediaRefRecord[],
  protectedIds: ReadonlySet<string>,
  policy: MediaLifecyclePolicy = {},
): {
  readonly result: MediaCleanupResult;
  readonly idsToDelete: readonly string[];
  readonly expiredRefs: readonly MediaRefRecord[];
} {
  const expiredRefs = expiredMediaRefs(refs, policy);
  const expired = new Set(expiredRefs);
  const { result, idsToDelete } = cleanupCandidates(
    assets,
    claimedMediaIds(
      protectedIds,
      assets,
      refs.filter((ref) => !expired.has(ref)),
    ),
    policy,
  );
  return {
    result: { ...result, expiredRefs: [...expiredRefs] },
    idsToDelete,
    expiredRefs,
  };
}

function claimedMediaIds(
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
