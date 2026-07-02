import type {
  MediaAssetRecord,
  MediaCleanupResult,
  MediaLifecyclePolicy,
} from "@covel/shared";
import { createHash } from "node:crypto";
import { join } from "node:path";

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
  const sorted = [...assets].sort((a, b) => {
    const byCreated = a.createdAt.localeCompare(b.createdAt);
    return byCreated === 0 ? a.id.localeCompare(b.id) : byCreated;
  });
  const idsToDelete = new Set<string>();
  let currentBytes = sorted.reduce((sum, asset) => sum + asset.size, 0);

  if (typeof policy.maxAgeMs === "number" && policy.maxAgeMs >= 0) {
    const cutoff = nowMs - policy.maxAgeMs;
    for (const asset of sorted) {
      if (protectedSet.has(asset.id)) continue;
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
      if (protectedSet.has(asset.id) || idsToDelete.has(asset.id)) continue;
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
      if (protectedSet.has(asset.id) || idsToDelete.has(asset.id)) continue;
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

export async function toBytes(blob: Uint8Array | Blob): Promise<Uint8Array> {
  if (blob instanceof Uint8Array) return new Uint8Array(blob);
  return new Uint8Array(await blob.arrayBuffer());
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function mediaPath(root: string, id: string): string {
  return join(root, id.slice(0, 2), id.slice(2, 4), `${id}.bin`);
}

export function toMeta(
  meta?: object,
): Readonly<Record<string, unknown>> | undefined {
  return meta === undefined
    ? undefined
    : { ...(meta as Record<string, unknown>) };
}

export function bytesToReadableStream(
  bytes: Uint8Array,
): ReadableStream<Uint8Array> {
  // Copy to a fresh Uint8Array so the stream owner can't observe later mutations
  // of the source buffer.
  const copy = new Uint8Array(bytes);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(copy);
      controller.close();
    },
  });
}

export function mediaObjectKey(id: string, prefix?: string): string {
  const key = `${id.slice(0, 2)}/${id.slice(2, 4)}/${id}.bin`;
  if (!prefix) return key;
  return `${prefix.replace(/\/+$/, "")}/${key}`;
}

export function normalizeBytes(value: Uint8Array | Buffer): Uint8Array {
  return new Uint8Array(
    value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
  );
}

/**
 * Shared listByMetadata used by ALL media backends (memory/sqlite/pg/idb):
 * one code path — backend parity by construction.
 * ponytail: full-scan over listAssets(); push down to SQL when per-session
 * media volume outgrows tens of records.
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
