import type { MediaRef, MediaRefRecord, MediaStore } from "@covel/shared";
import {
  bytesToReadableStream,
  cleanupCandidates,
  filterAssetsByMetadata,
  sha256,
  toBytes,
  toMeta,
} from "./utils.js";

interface StoredMedia {
  readonly bytes: Uint8Array;
  readonly ref: MediaRef;
  readonly createdAt: string;
}

interface OwnerRecord {
  readonly sessionId: string;
  readonly pluginId: string | null;
}

export function createMemoryMediaStore(): MediaStore {
  const assets = new Map<string, StoredMedia>();
  const owners = new Map<string, OwnerRecord>();
  // Inverted index: sessionId → set of media ids referenced. Mirrors the
  // SQLite media_refs table so isReferencedBy() can stay O(1).
  const refs = new Map<string, Set<string>>();
  const refRows = new Map<string, MediaRefRecord>();

  function addRefInternal(sessionId: string, id: string): void {
    let set = refs.get(sessionId);
    if (!set) {
      set = new Set<string>();
      refs.set(sessionId, set);
    }
    set.add(id);
  }

  return {
    async put(blob, mime, meta) {
      const bytes = await toBytes(blob);
      const id = sha256(bytes);
      const existing = assets.get(id);
      if (existing) return existing.ref;
      const ref: MediaRef = {
        id,
        mime,
        size: bytes.byteLength,
        ...(meta === undefined ? {} : { meta: toMeta(meta) }),
      };
      assets.set(id, {
        bytes: new Uint8Array(bytes),
        ref,
        createdAt: new Date().toISOString(),
      });
      return ref;
    },

    async get(ref) {
      const asset = assets.get(ref.id);
      if (!asset) throw new Error(`Media asset not found: ${ref.id}`);
      return new Uint8Array(asset.bytes);
    },

    async exists(id) {
      return assets.has(id);
    },

    async resolveUrl(ref) {
      if (ref.url) return ref.url;
      if (!assets.has(ref.id))
        throw new Error(`Media asset not found: ${ref.id}`);
      return `memory://media/${ref.id}`;
    },

    async delete(id) {
      assets.delete(id);
      owners.delete(id);
      // Drop reverse refs so isReferencedBy stays consistent across delete/recreate.
      for (const set of refs.values()) {
        set.delete(id);
      }
      for (const [key, row] of refRows) {
        if (row.mediaId === id) refRows.delete(key);
      }
    },

    async lookup(id) {
      const asset = assets.get(id);
      if (!asset) return null;
      const owner = owners.get(id);
      return {
        id,
        mime: asset.ref.mime,
        size: asset.ref.size,
        ownerSessionId: owner?.sessionId ?? null,
        ownerPluginId: owner?.pluginId ?? null,
      };
    },

    async recordOwnership(id, ownerSessionId, ownerPluginId) {
      if (!assets.has(id)) return;
      const existing = owners.get(id);
      if (existing && existing.sessionId !== ownerSessionId) {
        // First-writer wins: do not overwrite a different session's ownership.
        return;
      }
      owners.set(id, {
        sessionId: ownerSessionId,
        pluginId: ownerPluginId ?? null,
      });
    },

    async addRef(id, sessionId, pluginId) {
      if (!assets.has(id)) return;
      addRefInternal(sessionId, id);
      // First writer wins for plugin_id — keyed only on (sessionId, mediaId)
      // to mirror the UNIQUE constraint enforced by SQLite/PG.
      const key = `${sessionId}\u0000${id}`;
      if (!refRows.has(key)) {
        refRows.set(key, {
          sessionId,
          mediaId: id,
          pluginId: pluginId ?? null,
          createdAt: new Date().toISOString(),
        });
      }
    },

    async removeRef(id, sessionId) {
      refs.get(sessionId)?.delete(id);
      refRows.delete(`${sessionId}\u0000${id}`);
    },

    async isReferencedBy(id, sessionId) {
      const owner = owners.get(id);
      if (owner?.sessionId === sessionId) return true;
      return refs.get(sessionId)?.has(id) ?? false;
    },

    async listAssets() {
      return [...assets.values()].map((asset) => {
        const owner = owners.get(asset.ref.id);
        return {
          id: asset.ref.id,
          mime: asset.ref.mime,
          size: asset.ref.size,
          ownerSessionId: owner?.sessionId ?? null,
          ownerPluginId: owner?.pluginId ?? null,
          createdAt: asset.createdAt,
          ...(asset.ref.meta === undefined ? {} : { meta: asset.ref.meta }),
        };
      });
    },

    async listRefs() {
      return [...refRows.values()];
    },

    async listByMetadata(sessionId, filter) {
      return filterAssetsByMetadata(await this.listAssets(), sessionId, filter);
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
      const asset = assets.get(ref.id);
      if (!asset) throw new Error(`Media asset not found: ${ref.id}`);
      return bytesToReadableStream(asset.bytes);
    },
  };
}
