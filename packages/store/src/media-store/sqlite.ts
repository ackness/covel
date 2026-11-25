import { randomUUID } from "node:crypto";
import type {
  MediaAssetRecord,
  MediaRef,
  MediaRefRecord,
  MediaStore,
} from "@covel/shared";
import {
  acquireSqliteConnection,
  getConnectionWriteGate,
  releaseSqliteConnection,
} from "../sqlite/shared-connection.js";
import { runSqliteTransaction } from "../sqlite/node-sqlite.js";
import { MEDIA_WRITE_METHODS } from "../store-write-methods.js";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  access,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { createTables } from "../sqlite/sqlite-schema-ddl.js";
import type { SqliteMediaStoreOptions } from "./types.js";
import {
  finalizeMediaCleanupResult,
  planMediaCleanup,
} from "./cleanup-result.js";
import {
  assertMediaClaims,
  filterAssetsByMetadata,
  mediaPath,
  sha256,
  toBytes,
  toMeta,
} from "./utils.js";

export function createSqliteMediaStore(
  dbPath: string,
  options?: SqliteMediaStoreOptions,
): MediaStore {
  const dbDir = dirname(dbPath);
  if (dbDir && dbDir !== "." && dbDir !== ":memory:") {
    mkdirSync(dbDir, { recursive: true });
  }

  // Reuse the DataStore's connection for this file. Two connections to one
  // covel.db deadlock when the mirror media store writes (e.g. session-import
  // materializing world portraits) while the main store holds a write
  // transaction. See sqlite/shared-connection.ts.
  const sqlite = acquireSqliteConnection(dbPath);
  try {
    return initializeSqliteMediaStore(sqlite, dbDir, options);
  } catch (error) {
    // Until construction returns, this factory owns the acquired reference.
    try {
      releaseSqliteConnection(sqlite);
    } catch {
      // Preserve the initialization error without logging private paths/details.
      console.warn("[store] SQLite media initialization cleanup failed");
    }
    throw error;
  }
}

function initializeSqliteMediaStore(
  sqlite: ReturnType<typeof acquireSqliteConnection>,
  dbDir: string,
  options?: SqliteMediaStoreOptions,
): MediaStore {
  createTables(sqlite);

  const mediaRoot = resolve(
    options?.mediaRoot ??
      join(dbDir === ":memory:" ? process.cwd() : dbDir, "media"),
  );
  mkdirSync(mediaRoot, { recursive: true });

  // Stored paths are portable, relative to mediaRoot; old absolute paths are
  // not part of the current contract and must never touch the previous root.
  const filePath = (storedPath: string): string => {
    if (
      isAbsolute(storedPath) ||
      !/^[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{64}\.bin$/.test(storedPath)
    ) {
      throw new Error("Invalid relative media path; recreate development data");
    }
    return join(mediaRoot, storedPath);
  };

  const insertAsset = sqlite.prepare(`
    INSERT INTO media_assets (id, sha256, mime, size, path, meta, created_at)
    VALUES (@id, @sha256, @mime, @size, @path, @meta, @createdAt)
    ON CONFLICT(id) DO NOTHING
  `);
  const select = sqlite.prepare(
    "SELECT id, mime, size, path, meta, owner_session_id AS ownerSessionId, owner_plugin_id AS ownerPluginId FROM media_assets WHERE id = ?",
  );
  const selectAllAssets = sqlite.prepare(`
    SELECT id, mime, size, meta, owner_session_id AS ownerSessionId, owner_plugin_id AS ownerPluginId, created_at AS createdAt
    FROM media_assets
    ORDER BY created_at ASC, id ASC
  `);
  const selectOwnedAssets = sqlite.prepare(`
    SELECT id, mime, size, meta, owner_session_id AS ownerSessionId, owner_plugin_id AS ownerPluginId, created_at AS createdAt
    FROM media_assets
    WHERE owner_session_id = ?
    ORDER BY created_at ASC, id ASC
  `);
  const selectAllRefs = sqlite.prepare(`
    SELECT media_id AS mediaId, session_id AS sessionId, plugin_id AS pluginId, created_at AS createdAt
    FROM media_refs
    ORDER BY created_at ASC, session_id ASC, media_id ASC
  `);
  const remove = sqlite.prepare("DELETE FROM media_assets WHERE id = ?");
  const removeRefs = sqlite.prepare(
    "DELETE FROM media_refs WHERE media_id = ?",
  );
  const deleteAsset = (id: string) =>
    runSqliteTransaction(
      sqlite,
      () => {
        const row = select.get(id) as { path: string } | undefined;
        removeRefs.run(id);
        remove.run(id);
        if (row?.path) rmSync(filePath(row.path), { force: true });
      },
      "immediate",
    );
  const selectAnyRef = sqlite.prepare(
    "SELECT 1 AS one FROM media_refs WHERE media_id = ? LIMIT 1",
  );
  const deleteUnreferencedAsset = (id: string) =>
    runSqliteTransaction(
      sqlite,
      () => {
        const row = select.get(id) as
          { path: string; ownerSessionId: string | null } | undefined;
        if (!row || row.ownerSessionId !== null) return null;
        if (selectAnyRef.get(id)) return null;
        remove.run(id);
        rmSync(filePath(row.path), { force: true });
        return filePath(row.path);
      },
      "immediate",
    );

  // First-writer wins guard: only set owner when row has no owner yet, or
  // when the caller already owns it (idempotent re-record). Prevents a
  // second session/plugin silently stealing ownership of an existing asset.
  const updateOwnership = sqlite.prepare(`
    UPDATE media_assets
    SET owner_session_id = @sessionId, owner_plugin_id = @pluginId
    WHERE id = @id
      AND (owner_session_id IS NULL OR owner_session_id = @sessionId)
  `);
  const insertRef = sqlite.prepare(`
    INSERT INTO media_refs (session_id, media_id, plugin_id, created_at)
    SELECT @sessionId, @mediaId, @pluginId, @createdAt
    WHERE EXISTS (SELECT 1 FROM media_assets WHERE id = @mediaId)
    ON CONFLICT(session_id, media_id) DO UPDATE SET created_at = excluded.created_at
  `);
  const removeRef = sqlite.prepare(`
    DELETE FROM media_refs
    WHERE media_id = @mediaId
      AND session_id = @sessionId
  `);
  // Matches the creation time too: only the row a cleanup plan saw is released.
  const removeExpiredRef = sqlite.prepare(`
    DELETE FROM media_refs
    WHERE media_id = @mediaId
      AND session_id = @sessionId
      AND created_at = @createdAt
  `);
  const removeSessionRefs = sqlite.prepare(
    "DELETE FROM media_refs WHERE session_id = ?",
  );
  const clearSessionOwnership = sqlite.prepare(`
    UPDATE media_assets
    SET owner_session_id = NULL, owner_plugin_id = NULL
    WHERE owner_session_id = ?
  `);
  const checkOwner = sqlite.prepare(
    "SELECT owner_session_id AS ownerSessionId FROM media_assets WHERE id = ?",
  );
  const checkRef = sqlite.prepare(
    "SELECT 1 AS one FROM media_refs WHERE session_id = ? AND media_id = ? LIMIT 1",
  );

  /**
   * Put complete bytes at `path`, or leave no file there: the content goes to
   * a file of its own first and takes the final name in one rename.
   */
  const publishFile = async (path: string, bytes: Uint8Array) => {
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, bytes, { flag: "wx" });
      await rename(temporaryPath, path);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  };

  /** {@link publishFile} for the transaction below, which cannot wait. */
  const publishFileSync = (path: string, bytes: Uint8Array) => {
    mkdirSync(dirname(path), { recursive: true });
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, bytes, { flag: "wx" });
      renameSync(temporaryPath, path);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  };

  /**
   * Record an asset whose bytes {@link publishFile} has normally put on disk
   * already. The row, the claim and the last look at the file share one write
   * transaction, as they did when the file was written here: a deletion from
   * another process lands before it or after it, never in between. A file
   * that such a deletion took since is written again here.
   */
  const recordAsset = async (
    bytes: Uint8Array,
    id: string,
    mime: string,
    meta: Readonly<Record<string, unknown>> | undefined,
    initialRef: Parameters<MediaStore["put"]>[3],
  ): Promise<MediaRef> =>
    runSqliteTransaction(
      sqlite,
      () => {
        const claim = () => {
          if (initialRef)
            insertRef.run({
              sessionId: initialRef.sessionId,
              mediaId: id,
              pluginId: initialRef.pluginId ?? null,
              createdAt: new Date().toISOString(),
            });
        };
        const existing = select.get(id) as
          | {
              id: string;
              mime: string;
              size: number;
              path: string;
              meta: string | null;
            }
          | undefined;
        if (existing) {
          // The row survives when the file was deleted or not restored from
          // a backup; writing the same bytes again repairs it.
          if (!existsSync(filePath(existing.path)))
            publishFileSync(filePath(existing.path), bytes);
          claim();
          return {
            id: existing.id,
            mime: existing.mime,
            size: existing.size,
            ...(existing.meta
              ? {
                  meta: JSON.parse(existing.meta) as Readonly<
                    Record<string, unknown>
                  >,
                }
              : {}),
          };
        }
        const path = mediaPath(mediaRoot, id);
        if (!existsSync(path)) publishFileSync(path, bytes);
        const ref: MediaRef = {
          id,
          mime,
          size: bytes.byteLength,
          ...(meta === undefined ? {} : { meta: toMeta(meta) }),
        };
        insertAsset.run({
          id,
          sha256: id,
          mime,
          size: bytes.byteLength,
          path: `${id.slice(0, 2)}/${id.slice(2, 4)}/${id}.bin`,
          meta: meta === undefined ? null : JSON.stringify(meta),
          createdAt: new Date().toISOString(),
        });
        claim();
        return ref;
      },
      "immediate",
    );

  // Same connection as the DataStore ⇒ same operation gate. Without this a
  // media read or write issued while another caller's transaction is open
  // either observes uncommitted writes that later roll back, or joins that
  // transaction and vanishes on rollback. File I/O in `put`, `get`, and
  // `openReadStream` stays outside the gate so large reads/uploads never stall
  // other DB operations; only their DB statements wait for the gate.
  const gate = getConnectionWriteGate(sqlite);
  const gatedDb = gate.gateWrites(
    {
      recordAsset,
      lookupPath: async (id: string) =>
        select.get(id) as { path: string } | undefined,
    },
    new Set(["recordAsset", "lookupPath"]),
  );
  const orphanGraceMs = Math.max(0, options?.orphanFileGraceMs ?? 60_000);

  const sweepOrphanMediaFiles = async (): Promise<void> => {
    const cutoffMs = Date.now() - orphanGraceMs;
    const level1 = await readdir(mediaRoot, { withFileTypes: true }).catch(
      () => [],
    );
    for (const d1 of level1) {
      if (!d1.isDirectory() || !/^[a-f0-9]{2}$/.test(d1.name)) continue;
      const p1 = join(mediaRoot, d1.name);
      const level2 = await readdir(p1, { withFileTypes: true }).catch(() => []);
      for (const d2 of level2) {
        if (!d2.isDirectory() || !/^[a-f0-9]{2}$/.test(d2.name)) continue;
        const p2 = join(p1, d2.name);
        const files = await readdir(p2, { withFileTypes: true }).catch(
          () => [],
        );
        for (const file of files) {
          if (!file.isFile()) continue;
          const match = /^([a-f0-9]{64})\.bin$/.exec(file.name);
          if (!match) continue;
          const id = match[1]!;
          if (select.get(id)) continue;
          const full = join(p2, file.name);
          const info = await stat(full).catch(() => null);
          if (!info || info.mtimeMs > cutoffMs) continue;
          // Re-check inside the held gate right before removing so a put that
          // registered the row concurrently cannot lose its backing file.
          if (select.get(id)) continue;
          await rm(full, { force: true }).catch(() => {});
        }
      }
    }
  };

  const store: MediaStore = {
    // The file is written before the gate is taken, without blocking the
    // event loop: an upload of several megabytes holds up neither the streams
    // of other sessions nor their database writes. Only the row waits its turn.
    async put(blob, mime, meta, initialRef) {
      const cleanMeta = toMeta(meta);
      const bytes = await toBytes(blob);
      const id = sha256(bytes);
      const known = await gatedDb.lookupPath(id);
      let newlyPublishedPath: string | undefined;
      // A row vouches for its file; without one, a file left by an interrupted
      // earlier write is replaced from the caller's verified content as well.
      if (!known) {
        const target = mediaPath(mediaRoot, id);
        await publishFile(target, bytes);
        newlyPublishedPath = target;
      } else if (!(await isReadable(filePath(known.path)))) {
        await publishFile(filePath(known.path), bytes);
      }
      try {
        return await gatedDb.recordAsset(bytes, id, mime, cleanMeta, initialRef);
      } catch (error) {
        if (newlyPublishedPath) {
          const existsInDb = await gatedDb.lookupPath(id).catch(() => undefined);
          if (!existsInDb) {
            await rm(newlyPublishedPath, { force: true }).catch(() => {});
          }
        }
        throw error;
      }
    },

    async get(ref) {
      const row = await gatedDb.lookupPath(ref.id);
      if (!row) throw new Error(`Media asset not found: ${ref.id}`);
      return new Uint8Array(await readFile(filePath(row.path)));
    },

    async exists(id) {
      const row = select.get(id) as { path: string } | undefined;
      return row !== undefined && existsSync(filePath(row.path));
    },

    async delete(id) {
      if (sqlite.isTransaction)
        throw new Error(
          "SQLite media deletion must run outside an existing SQL transaction",
        );
      // Clean up the inbound refs first so a foreign-key-style invariant holds
      // even though the schema has no explicit FK between the two tables. The
      // transaction also excludes a writer in another OS process from adding a
      // ref between the two statements and leaving it dangling.
      deleteAsset(id);
    },

    async lookup(id) {
      const row = select.get(id) as
        | {
            id: string;
            mime: string;
            size: number;
            ownerSessionId: string | null;
            ownerPluginId: string | null;
          }
        | undefined;
      if (!row) return null;
      return {
        id: row.id,
        mime: row.mime,
        size: row.size,
        ownerSessionId: row.ownerSessionId ?? null,
        ownerPluginId: row.ownerPluginId ?? null,
      };
    },

    async recordOwnership(id, ownerSessionId, ownerPluginId) {
      updateOwnership.run({
        id,
        sessionId: ownerSessionId,
        pluginId: ownerPluginId ?? null,
      });
    },

    async addRef(id, sessionId, pluginId) {
      // UNIQUE key is (session_id, media_id) only — first writer wins for
      // plugin_id, while re-claiming refreshes created_at so an active holder
      // is not expired.
      insertRef.run({
        sessionId,
        mediaId: id,
        pluginId: pluginId ?? null,
        createdAt: new Date().toISOString(),
      });
    },

    async claimAssets(claims) {
      assertMediaClaims(claims);
      if (claims.length === 0) return;
      const createdAt = new Date().toISOString();
      runSqliteTransaction(sqlite, () => {
        for (const { id, sessionId, pluginId } of claims) {
          updateOwnership.run({ id, sessionId, pluginId: pluginId ?? null });
          insertRef.run({
            sessionId,
            mediaId: id,
            pluginId: pluginId ?? null,
            createdAt,
          });
        }
      });
    },

    async removeRef(id, sessionId) {
      removeRef.run({ mediaId: id, sessionId });
    },

    async releaseSession(sessionId) {
      runSqliteTransaction(sqlite, () => {
        removeSessionRefs.run(sessionId);
        clearSessionOwnership.run(sessionId);
      });
    },

    async isReferencedBy(id, sessionId) {
      const ownerRow = checkOwner.get(id) as
        { ownerSessionId: string | null } | undefined;
      if (ownerRow?.ownerSessionId === sessionId) return true;
      const refRow = checkRef.get(sessionId, id) as { one: number } | undefined;
      return refRow !== undefined;
    },

    async listAssets() {
      return (selectAllAssets.all() as AssetRow[]).map(toAssetRecord);
    },

    async listRefs() {
      return selectAllRefs.all() as unknown as MediaRefRecord[];
    },

    async listByMetadata(sessionId, filter) {
      const owned = (selectOwnedAssets.all(sessionId) as AssetRow[]).map(
        toAssetRecord,
      );
      return filterAssetsByMetadata(owned, sessionId, filter);
    },

    async cleanup(protectedIds, policy) {
      if (!policy?.dryRun && sqlite.isTransaction)
        throw new Error(
          "SQLite media cleanup must run outside an existing SQL transaction",
        );
      const inventory = await this.listAssets();
      const { result, idsToDelete, expiredRefs } = planMediaCleanup(
        inventory,
        await this.listRefs(),
        protectedIds,
        policy,
      );
      if (!policy?.dryRun) {
        const releasedRefs = expiredRefs.filter(
          (ref) =>
            removeExpiredRef.run({
              mediaId: ref.mediaId,
              sessionId: ref.sessionId,
              createdAt: ref.createdAt,
            }).changes > 0,
        );
        const deletedIds: string[] = [];
        for (const id of idsToDelete) {
          // BEGIN IMMEDIATE excludes another process's addRef/ownership write
          // across the final check and asset deletion.
          const path = deleteUnreferencedAsset(id);
          if (path === null) continue;
          deletedIds.push(id);
        }
        await sweepOrphanMediaFiles();
        return finalizeMediaCleanupResult(
          result,
          inventory,
          deletedIds,
          releasedRefs,
        );
      }
      return result;
    },

    async openReadStream(ref) {
      const row = await gatedDb.lookupPath(ref.id);
      if (!row) throw new Error(`Media asset not found: ${ref.id}`);
      // Node 22+ exposes Readable.toWeb; Covel's engines field requires Node ≥ 22.
      const nodeStream = createReadStream(filePath(row.path));
      return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
    },

    close() {
      releaseSqliteConnection(sqlite);
    },
  };

  // Gate every DB-touching read and write method on the shared connection
  // (matching SqliteStore), while `put`, `get`, and `openReadStream` gate only
  // their DB statements via `gatedDb` to keep disk I/O off the write gate.
  const gatedMethods = new Set([
    ...Object.keys(store).filter(
      (name) =>
        name !== "put" &&
        name !== "get" &&
        name !== "openReadStream" &&
        name !== "close",
    ),
    ...MEDIA_WRITE_METHODS,
  ]);
  return {
    ...gate.gateWrites(store, gatedMethods),
    put: store.put,
    get: store.get,
    openReadStream: store.openReadStream,
  };
}

async function isReadable(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

type AssetRow = {
  id: string;
  mime: string;
  size: number;
  meta: string | null;
  ownerSessionId: string | null;
  ownerPluginId: string | null;
  createdAt: string;
};

function toAssetRecord(row: AssetRow): MediaAssetRecord {
  return {
    id: row.id,
    mime: row.mime,
    size: row.size,
    ownerSessionId: row.ownerSessionId ?? null,
    ownerPluginId: row.ownerPluginId ?? null,
    createdAt: row.createdAt,
    ...(row.meta
      ? { meta: JSON.parse(row.meta) as Readonly<Record<string, unknown>> }
      : {}),
  };
}
