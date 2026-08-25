import type { MediaStore } from "@covel/shared";
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { filterAssetsByMetadata } from "../media-store/filter.js";
import { finalizeMediaCleanupResult } from "../media-store/cleanup-result.js";
import {
  cloneMeta,
  type IdbMediaAssetRecord,
  type IdbMediaRefRecord,
  planMediaCleanup,
  refKey,
  sha256,
  sortAssetRecords,
  sortRefRecords,
  toAssetRecord,
  toBlobAndBytes,
  toLookup,
  toMediaRef,
  toRefRecord,
} from "./idb-media-records.js";
import {
  BROWSER_IDB_DATABASE_NAME,
  BROWSER_IDB_SCHEMA_VERSION,
  backfillSnapshotMetadata,
  upgradeBrowserIdbSchema,
} from "./idb-schema.js";

const DEFAULT_DB_NAME = BROWSER_IDB_DATABASE_NAME;
const DB_VERSION = BROWSER_IDB_SCHEMA_VERSION;
const STORE_ASSETS = "media_assets";
const STORE_REFS = "media_refs";

interface IdbMediaDb extends DBSchema {
  readonly [STORE_ASSETS]: {
    key: string;
    value: IdbMediaAssetRecord;
    indexes: {
      readonly owner: [string, string];
    };
  };
  readonly [STORE_REFS]: {
    key: string;
    value: IdbMediaRefRecord;
    indexes: {
      readonly sessionId: string;
      readonly mediaId: string;
      readonly session_media: [string, string];
    };
  };
}

export interface IndexedDbMediaStoreOptions {
  readonly dbName?: string;
}

async function openMediaDb(dbName: string): Promise<IDBPDatabase<IdbMediaDb>> {
  return openDB<IdbMediaDb>(dbName, DB_VERSION, {
    async upgrade(db, oldVersion, _newVersion, transaction) {
      await upgradeBrowserIdbSchema(db, oldVersion, transaction);
      if (oldVersion > 0 && oldVersion < 12) {
        await backfillSnapshotMetadata(transaction);
      }
    },
  });
}

export async function createIndexedDbMediaStore(
  options?: IndexedDbMediaStoreOptions,
): Promise<MediaStore> {
  const db = await openMediaDb(options?.dbName ?? DEFAULT_DB_NAME);

  async function deleteAsset(id: string): Promise<void> {
    const tx = db.transaction([STORE_ASSETS, STORE_REFS], "readwrite");
    await Promise.all([
      tx.objectStore(STORE_ASSETS).delete(id),
      (async () => {
        let cursor = await tx
          .objectStore(STORE_REFS)
          .index("mediaId")
          .openCursor(id);
        while (cursor) {
          await cursor.delete();
          cursor = await cursor.continue();
        }
      })(),
    ]);
    await tx.done;
  }

  async function deleteAssetIfUnreferenced(id: string): Promise<boolean> {
    const tx = db.transaction([STORE_ASSETS, STORE_REFS], "readwrite");
    const assets = tx.objectStore(STORE_ASSETS);
    const refs = tx.objectStore(STORE_REFS);
    const asset = await assets.get(id);
    if (!asset || asset.ownerSessionId !== null) {
      await tx.done;
      return false;
    }
    const ref = await refs.index("mediaId").getKey(id);
    if (ref !== undefined) {
      await tx.done;
      return false;
    }
    await assets.delete(id);
    await tx.done;
    return true;
  }

  return {
    async put(value, mime, meta) {
      const { blob, bytes } = await toBlobAndBytes(value, mime);
      const id = await sha256(bytes);
      // Keep the first-writer check and insert in one native transaction.
      // Readwrite transactions touching this store are serialized by IDB, so a
      // concurrent put of the same digest observes the committed first record
      // instead of overwriting its MIME/metadata.
      const tx = db.transaction(STORE_ASSETS, "readwrite");
      const existing = await tx.store.get(id);
      if (existing) {
        await tx.done;
        return toMediaRef(existing);
      }

      const record: IdbMediaAssetRecord = {
        id,
        mime,
        size: bytes.byteLength,
        blob,
        ...(meta === undefined ? {} : { meta: cloneMeta(meta) }),
        ownerSessionId: null,
        ownerPluginId: null,
        createdAt: new Date().toISOString(),
      };
      await tx.store.put(record);
      await tx.done;
      return toMediaRef(record);
    },

    async get(ref) {
      const record = await db.get(STORE_ASSETS, ref.id);
      if (!record) throw new Error(`Media asset not found: ${ref.id}`);
      return record.blob;
    },

    async exists(id) {
      return (await db.getKey(STORE_ASSETS, id)) !== undefined;
    },

    async resolveUrl(ref) {
      if (ref.url) return ref.url;
      const record = await db.get(STORE_ASSETS, ref.id);
      if (!record) throw new Error(`Media asset not found: ${ref.id}`);
      return URL.createObjectURL(record.blob);
    },

    async delete(id) {
      await deleteAsset(id);
    },

    async lookup(id) {
      const record = await db.get(STORE_ASSETS, id);
      return record ? toLookup(record) : null;
    },

    async recordOwnership(id, ownerSessionId, ownerPluginId) {
      // A single readwrite transaction makes the first-owner guard atomic
      // across tabs/handles.
      const tx = db.transaction(STORE_ASSETS, "readwrite");
      const record = await tx.store.get(id);
      if (!record) {
        await tx.done;
        return;
      }
      if (
        record.ownerSessionId !== null &&
        record.ownerSessionId !== ownerSessionId
      ) {
        await tx.done;
        return;
      }
      await tx.store.put({
        ...record,
        ownerSessionId,
        ownerPluginId: ownerPluginId ?? null,
      });
      await tx.done;
    },

    async addRef(id, sessionId, pluginId) {
      // Share the exact two-store transaction scope used by deleteAsset(). IDB
      // serializes overlapping readwrite transactions, so addRef either lands
      // before delete (and is removed by it) or observes the missing asset after
      // delete; it can never leave a dangling ref.
      const tx = db.transaction([STORE_ASSETS, STORE_REFS], "readwrite");
      const exists = await tx.objectStore(STORE_ASSETS).getKey(id);
      if (exists === undefined) {
        await tx.done;
        return;
      }
      const key = refKey(id, sessionId);
      // First-writer wins on plugin_id: skip the put if a row already exists.
      const refs = tx.objectStore(STORE_REFS);
      const existingRef = await refs.get(key);
      if (existingRef) {
        await tx.done;
        return;
      }
      await refs.put({
        key,
        mediaId: id,
        sessionId,
        pluginId: pluginId ?? null,
        createdAt: new Date().toISOString(),
      });
      await tx.done;
    },

    async removeRef(id, sessionId) {
      await db.delete(STORE_REFS, refKey(id, sessionId));
    },

    async releaseSession(sessionId) {
      const tx = db.transaction([STORE_ASSETS, STORE_REFS], "readwrite");
      let refCursor = await tx
        .objectStore(STORE_REFS)
        .index("sessionId")
        .openCursor(sessionId);
      while (refCursor) {
        await refCursor.delete();
        refCursor = await refCursor.continue();
      }
      let assetCursor = await tx.objectStore(STORE_ASSETS).openCursor();
      while (assetCursor) {
        if (assetCursor.value.ownerSessionId === sessionId) {
          await assetCursor.update({
            ...assetCursor.value,
            ownerSessionId: null,
            ownerPluginId: null,
          });
        }
        assetCursor = await assetCursor.continue();
      }
      await tx.done;
    },

    async isReferencedBy(id, sessionId) {
      const record = await db.get(STORE_ASSETS, id);
      if (record?.ownerSessionId === sessionId) return true;
      const key = await db.getKeyFromIndex(STORE_REFS, "session_media", [
        sessionId,
        id,
      ]);
      return key !== undefined;
    },

    async listAssets() {
      const rows = await db.getAll(STORE_ASSETS);
      return sortAssetRecords(rows.map(toAssetRecord));
    },

    async listRefs() {
      const rows = await db.getAll(STORE_REFS);
      return sortRefRecords(rows.map(toRefRecord));
    },

    async listByMetadata(sessionId, filter) {
      const rows = await db.getAll(STORE_ASSETS);
      return filterAssetsByMetadata(
        sortAssetRecords(rows.map(toAssetRecord)),
        sessionId,
        filter,
      );
    },

    async cleanup(protectedIds, policy = {}) {
      const assets = sortAssetRecords(
        (await db.getAll(STORE_ASSETS)).map(toAssetRecord),
      );
      const { result, idsToDelete } = planMediaCleanup(
        assets,
        protectedIds,
        policy,
      );

      if (!policy.dryRun) {
        const deletedIds: string[] = [];
        for (const id of idsToDelete) {
          // The ownership/ref check and delete share the same native transaction
          // as addRef/recordOwnership, closing the inventory-to-delete window.
          if (await deleteAssetIfUnreferenced(id)) deletedIds.push(id);
        }
        return finalizeMediaCleanupResult(result, assets, deletedIds);
      }

      return result;
    },

    async openReadStream(ref) {
      const record = await db.get(STORE_ASSETS, ref.id);
      if (!record) throw new Error(`Media asset not found: ${ref.id}`);
      return record.blob.stream() as ReadableStream<Uint8Array>;
    },

    close() {
      db.close();
    },
  };
}
