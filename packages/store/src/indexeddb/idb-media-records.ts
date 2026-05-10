import type {
  MediaAssetLookup,
  MediaAssetRecord,
  MediaCleanupResult,
  MediaLifecyclePolicy,
  MediaRef,
  MediaRefRecord,
} from "@covel/shared";

export interface IdbMediaAssetRecord {
  readonly id: string;
  readonly mime: string;
  readonly size: number;
  readonly blob: Blob;
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly ownerSessionId: string | null;
  readonly ownerPluginId: string | null;
  readonly createdAt: string;
}

export interface IdbMediaRefRecord {
  readonly key: string;
  readonly mediaId: string;
  readonly sessionId: string;
  readonly pluginId: string | null;
  readonly createdAt: string;
}

export async function toBlobAndBytes(
  value: Uint8Array | Blob,
  fallbackMime: string,
): Promise<{
  readonly blob: Blob;
  readonly bytes: Uint8Array;
}> {
  if (value instanceof Blob) {
    return {
      blob:
        value.type === fallbackMime
          ? value
          : value.slice(0, value.size, fallbackMime),
      bytes: new Uint8Array(await value.arrayBuffer()),
    };
  }
  const bytes = new Uint8Array(value);
  return {
    blob: new Blob([bytes], { type: fallbackMime }),
    bytes,
  };
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const input = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function toMediaRef(record: IdbMediaAssetRecord): MediaRef {
  return {
    id: record.id,
    mime: record.mime,
    size: record.size,
    ...(record.meta === undefined ? {} : { meta: record.meta }),
  };
}

export function toLookup(record: IdbMediaAssetRecord): MediaAssetLookup {
  return {
    id: record.id,
    mime: record.mime,
    size: record.size,
    ownerSessionId: record.ownerSessionId,
    ownerPluginId: record.ownerPluginId,
  };
}

export function toAssetRecord(record: IdbMediaAssetRecord): MediaAssetRecord {
  return {
    ...toLookup(record),
    createdAt: record.createdAt,
    ...(record.meta === undefined ? {} : { meta: record.meta }),
  };
}

export function toRefRecord(record: IdbMediaRefRecord): MediaRefRecord {
  return {
    mediaId: record.mediaId,
    sessionId: record.sessionId,
    pluginId: record.pluginId,
    createdAt: record.createdAt,
  };
}

// First writer wins: keyed only on (sessionId, mediaId), matching SQL
// backends' UNIQUE (session_id, media_id) constraint.
export function refKey(mediaId: string, sessionId: string): string {
  return `${sessionId}\u0000${mediaId}`;
}

export function cloneMeta(
  meta?: object,
): Readonly<Record<string, unknown>> | undefined {
  return meta === undefined
    ? undefined
    : { ...(meta as Record<string, unknown>) };
}

export function sortAssetRecords(
  assets: readonly MediaAssetRecord[],
): MediaAssetRecord[] {
  return [...assets].sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}

export function sortRefRecords(
  refs: readonly MediaRefRecord[],
): MediaRefRecord[] {
  return [...refs].sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) ||
      a.sessionId.localeCompare(b.sessionId) ||
      a.mediaId.localeCompare(b.mediaId),
  );
}

export function planMediaCleanup(
  assets: readonly MediaAssetRecord[],
  protectedIds: ReadonlySet<string>,
  policy: MediaLifecyclePolicy = {},
): {
  readonly result: MediaCleanupResult;
  readonly idsToDelete: readonly string[];
} {
  const nowMs = policy.now?.getTime() ?? Date.now();
  const protectedSet = new Set(protectedIds);
  const sorted = sortAssetRecords(assets);
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
