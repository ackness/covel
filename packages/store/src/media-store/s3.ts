import type {
  MediaAssetRecord,
  MediaRef,
  MediaRefRecord,
  MediaStore,
} from "@covel/shared";
import type {
  S3CompatibleMediaClient,
  S3MediaMetadataAdapter,
  S3MediaStoreOptions,
} from "./types.js";
import {
  bytesToReadableStream,
  cleanupCandidates,
  mediaObjectKey,
  sha256,
  toBytes,
  toMeta,
} from "./utils.js";

/**
 * In-memory fallback metadata adapter. Used when `S3MediaStoreOptions.
 * metadataAdapter` is not supplied. NOT durable: owner / refs / mime / size
 * are lost on restart, and multiple server instances cannot share state.
 * Production deployments MUST inject a real adapter (e.g.
 * `createSqliteS3MetadataAdapter` or a future PG variant).
 */
function createInMemoryS3MetadataAdapter(): S3MediaMetadataAdapter {
  const assets = new Map<string, MediaAssetRecord>();
  const refRows = new Map<string, MediaRefRecord>();

  return {
    async upsertAsset(record) {
      const existing = assets.get(record.id);
      // First writer wins to match content-addressed semantics.
      if (existing) return;
      assets.set(record.id, record);
    },
    async getAsset(id) {
      return assets.get(id) ?? null;
    },
    async recordOwnership(id, ownerSessionId, ownerPluginId) {
      const asset = assets.get(id);
      if (!asset) return;
      if (asset.ownerSessionId && asset.ownerSessionId !== ownerSessionId)
        return;
      assets.set(id, {
        ...asset,
        ownerSessionId,
        ownerPluginId: ownerPluginId ?? null,
      });
    },
    async addRef(id, sessionId, pluginId) {
      if (!assets.has(id)) return;
      // First writer wins on (sessionId, mediaId). Mirrors UNIQUE constraint
      // enforced by SQLite/PG metadata backends.
      const key = `${sessionId}\u0000${id}`;
      if (refRows.has(key)) return;
      refRows.set(key, {
        sessionId,
        mediaId: id,
        pluginId: pluginId ?? null,
        createdAt: new Date().toISOString(),
      });
    },
    async removeRef(id, sessionId) {
      refRows.delete(`${sessionId}\u0000${id}`);
    },
    async isReferencedBy(id, sessionId) {
      const asset = assets.get(id);
      if (asset?.ownerSessionId === sessionId) return true;
      return refRows.has(`${sessionId}\u0000${id}`);
    },
    async listAssets() {
      return [...assets.values()].sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      );
    },
    async listRefs() {
      return [...refRows.values()];
    },
    async deleteAsset(id) {
      assets.delete(id);
      for (const [key, row] of refRows) {
        if (row.mediaId === id) refRows.delete(key);
      }
    },
  };
}

export function createS3MediaStore(
  client: S3CompatibleMediaClient,
  options?: S3MediaStoreOptions,
): MediaStore {
  let adapter: S3MediaMetadataAdapter;
  if (options?.metadataAdapter) {
    adapter = options.metadataAdapter;
  } else {
    // Surface the durability gap once at construction so operators can't
    // miss it in dev. Stays out of the hot path (no per-request log spam).
    // eslint-disable-next-line no-console
    console.warn(
      "[covel/store] createS3MediaStore: no metadataAdapter supplied; " +
        "falling back to in-memory metadata. Ownership and refs will NOT " +
        "survive restarts and cannot be shared across server instances. " +
        "Pass metadataAdapter: createSqliteS3MetadataAdapter(...) (or an " +
        "equivalent PG adapter) for production.",
    );
    adapter = createInMemoryS3MetadataAdapter();
  }

  function makeUrl(ref: MediaRef): string {
    if (options?.publicBaseUrl) {
      return `${options.publicBaseUrl.replace(/\/+$/, "")}/${mediaObjectKey(ref.id, options.keyPrefix)}`;
    }
    const bucket = options?.bucket ?? "media";
    return `s3://${bucket}/${mediaObjectKey(ref.id, options?.keyPrefix)}`;
  }

  function recordToRef(record: MediaAssetRecord): MediaRef {
    return {
      id: record.id,
      mime: record.mime,
      size: record.size,
      ...(record.meta === undefined ? {} : { meta: record.meta }),
    };
  }

  return {
    async put(blob, mime, meta) {
      const bytes = await toBytes(blob);
      const id = sha256(bytes);
      const existing = await adapter.getAsset(id);
      if (existing) return recordToRef(existing);

      const key = mediaObjectKey(id, options?.keyPrefix);
      // Re-attach metadata for an object that's already in the bucket but
      // missing from the adapter (e.g. populated by another process or a
      // restored backup). headObject() preserves first-writer semantics.
      const head = await client.headObject(key);
      if (head) {
        const record: MediaAssetRecord = {
          id,
          mime: head.mime,
          size: head.size,
          ownerSessionId: null,
          ownerPluginId: null,
          createdAt: new Date().toISOString(),
          ...(head.meta === undefined ? {} : { meta: head.meta }),
        };
        await adapter.upsertAsset(record);
        return recordToRef(record);
      }

      const record: MediaAssetRecord = {
        id,
        mime,
        size: bytes.byteLength,
        ownerSessionId: null,
        ownerPluginId: null,
        createdAt: new Date().toISOString(),
        ...(meta === undefined ? {} : { meta: toMeta(meta) }),
      };
      await client.putObject({
        key,
        bytes: new Uint8Array(bytes),
        mime,
        ...(record.meta === undefined ? {} : { meta: record.meta }),
      });
      await adapter.upsertAsset(record);
      return recordToRef(record);
    },

    async get(ref) {
      const object = await client.getObject(
        mediaObjectKey(ref.id, options?.keyPrefix),
      );
      if (!object) throw new Error(`Media asset not found: ${ref.id}`);
      return new Uint8Array(object.bytes);
    },

    async exists(id) {
      return (
        (await client.headObject(mediaObjectKey(id, options?.keyPrefix))) !=
        null
      );
    },

    async resolveUrl(ref) {
      if (ref.url) return ref.url;
      const key = mediaObjectKey(ref.id, options?.keyPrefix);
      if ((await client.headObject(key)) == null)
        throw new Error(`Media asset not found: ${ref.id}`);
      return client.createSignedGetUrl
        ? client.createSignedGetUrl(key)
        : makeUrl(ref);
    },

    async delete(id) {
      await client.deleteObject(mediaObjectKey(id, options?.keyPrefix));
      await adapter.deleteAsset(id);
    },

    async lookup(id) {
      const record = await adapter.getAsset(id);
      if (record) {
        return {
          id: record.id,
          mime: record.mime,
          size: record.size,
          ownerSessionId: record.ownerSessionId,
          ownerPluginId: record.ownerPluginId,
        };
      }
      // Adapter has no row but the bucket still holds the bytes — best-effort
      // surface mime/size from headObject so callers can at least serve the
      // asset. Owner is null because we have no metadata source.
      const key = mediaObjectKey(id, options?.keyPrefix);
      const object = await client.headObject(key);
      if (!object) return null;
      return {
        id,
        mime: object.mime,
        size: object.size,
        ownerSessionId: null,
        ownerPluginId: null,
      };
    },

    async recordOwnership(id, ownerSessionId, ownerPluginId) {
      // exists() short-circuit prevents stamping ownership on a missing object
      // (mirrors Memory/SQLite/IDB which guard via the assets map / row).
      if (!(await this.exists(id))) return;
      await adapter.recordOwnership(id, ownerSessionId, ownerPluginId);
    },

    async addRef(id, sessionId, pluginId) {
      if (!(await this.exists(id))) return;
      await adapter.addRef(id, sessionId, pluginId);
    },

    async removeRef(id, sessionId) {
      await adapter.removeRef(id, sessionId);
    },

    async isReferencedBy(id, sessionId) {
      return adapter.isReferencedBy(id, sessionId);
    },

    async listAssets() {
      return adapter.listAssets();
    },

    async listRefs() {
      return adapter.listRefs();
    },

    async cleanup(protectedIds, policy) {
      const { result, idsToDelete } = cleanupCandidates(
        await this.listAssets(),
        protectedIds,
        policy,
      );
      if (!policy?.dryRun) {
        for (const id of idsToDelete) {
          await this.delete(id);
        }
      }
      return result;
    },

    async openReadStream(ref) {
      const bytes = await this.get(ref);
      return bytesToReadableStream(await toBytes(bytes));
    },
  };
}
