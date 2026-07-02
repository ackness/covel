import type { MediaStore } from "@covel/shared";
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { filterAssetsByMetadata } from "../media-store/utils.js";
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
    upgrade(db, oldVersion) {
      upgradeBrowserIdbSchema(db, oldVersion);
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

  return {
    async put(value, mime, meta) {
      const { blob, bytes } = await toBlobAndBytes(value, mime);
      const id = await sha256(bytes);
      const existing = await db.get(STORE_ASSETS, id);
      if (existing) return toMediaRef(existing);

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
      await db.put(STORE_ASSETS, record);
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
      const record = await db.get(STORE_ASSETS, id);
      if (!record) return;
      if (
        record.ownerSessionId !== null &&
        record.ownerSessionId !== ownerSessionId
      )
        return;
      await db.put(STORE_ASSETS, {
        ...record,
        ownerSessionId,
        ownerPluginId: ownerPluginId ?? null,
      });
    },

    async addRef(id, sessionId, pluginId) {
      const exists = await db.getKey(STORE_ASSETS, id);
      if (exists === undefined) return;
      const key = refKey(id, sessionId);
      // First-writer wins on plugin_id: skip the put if a row already exists.
      const existingRef = await db.get(STORE_REFS, key);
      if (existingRef) return;
      await db.put(STORE_REFS, {
        key,
        mediaId: id,
        sessionId,
        pluginId: pluginId ?? null,
        createdAt: new Date().toISOString(),
      });
    },

    async removeRef(id, sessionId) {
      await db.delete(STORE_REFS, refKey(id, sessionId));
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
        for (const id of idsToDelete) {
          await deleteAsset(id);
        }
      }

      return result;
    },

    async openReadStream(ref) {
      const record = await db.get(STORE_ASSETS, ref.id);
      if (!record) throw new Error(`Media asset not found: ${ref.id}`);
      return record.blob.stream() as ReadableStream<Uint8Array>;
    },
  };
}
