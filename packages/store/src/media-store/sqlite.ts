import { randomUUID } from "node:crypto";
import type { MediaRef, MediaRefRecord, MediaStore } from "@covel/shared";
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
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { createTables } from "../sqlite/sqlite-store-mappers.js";
import type { SqliteMediaStoreOptions } from "./types.js";
import {
  claimedMediaIds,
  finalizeMediaCleanupResult,
} from "./cleanup-result.js";
import { cleanupCandidates } from "./cleanup-policy.js";
import {
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
        if (row?.path) rmSync(row.path, { force: true });
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
        rmSync(row.path, { force: true });
        return row.path;
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
    INSERT OR IGNORE INTO media_refs (session_id, media_id, plugin_id, created_at)
    SELECT @sessionId, @mediaId, @pluginId, @createdAt
    WHERE EXISTS (SELECT 1 FROM media_assets WHERE id = @mediaId)
  `);
  const removeRef = sqlite.prepare(`
    DELETE FROM media_refs
    WHERE media_id = @mediaId
      AND session_id = @sessionId
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
          if (!existsSync(existing.path)) publishFileSync(existing.path, bytes);
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
          path,
          meta: meta === undefined ? null : JSON.stringify(meta),
          createdAt: new Date().toISOString(),
        });
        claim();
        return ref;
      },
      "immediate",
    );

  // Same connection as the DataStore ⇒ same operation gate. Without this a
  // media write issued while another caller's transaction is open joins that
  // transaction and is silently lost when it rolls back. Cleanup now performs
  // its conditional DB deletion inline (rather than recursively calling the
  // wrapped `delete`), so it can safely hold the gate for its complete sweep.
  const gate = getConnectionWriteGate(sqlite);
  const gatedRecord = gate.gateWrites(
    { recordAsset },
    new Set(["recordAsset"]),
  ).recordAsset;

  const store: MediaStore = {
    // The file is written before the gate is taken, without blocking the
    // event loop: an upload of several megabytes holds up neither the streams
    // of other sessions nor their database writes. Only the row waits its turn.
    async put(blob, mime, meta, initialRef) {
      const cleanMeta = toMeta(meta);
      const bytes = await toBytes(blob);
      const id = sha256(bytes);
      const known = select.get(id) as { path: string } | undefined;
      // A row vouches for its file; without one, a file left by an interrupted
      // earlier write is replaced from the caller's verified content as well.
      if (!known) await publishFile(mediaPath(mediaRoot, id), bytes);
      else if (!(await isReadable(known.path)))
        await publishFile(known.path, bytes);
      return gatedRecord(bytes, id, mime, cleanMeta, initialRef);
    },

    async get(ref) {
      const row = select.get(ref.id) as { path: string } | undefined;
      if (!row) throw new Error(`Media asset not found: ${ref.id}`);
      return new Uint8Array(await readFile(row.path));
    },

    async exists(id) {
      const row = select.get(id) as { path: string } | undefined;
      return row !== undefined && existsSync(row.path);
    },

    async resolveUrl(ref) {
      if (ref.url) return ref.url;
      const row = select.get(ref.id) as { path: string } | undefined;
      if (!row) throw new Error(`Media asset not found: ${ref.id}`);
      return pathToFileURL(row.path).toString();
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
      // plugin_id. A subsequent addRef with a different pluginId is a no-op
      // (INSERT OR IGNORE swallows the unique-violation).
      insertRef.run({
        sessionId,
        mediaId: id,
        pluginId: pluginId ?? null,
        createdAt: new Date().toISOString(),
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
      const rows = selectAllAssets.all() as Array<{
        id: string;
        mime: string;
        size: number;
        meta: string | null;
        ownerSessionId: string | null;
        ownerPluginId: string | null;
        createdAt: string;
      }>;
      return rows.map((row) => ({
        id: row.id,
        mime: row.mime,
        size: row.size,
        ownerSessionId: row.ownerSessionId ?? null,
        ownerPluginId: row.ownerPluginId ?? null,
        createdAt: row.createdAt,
        ...(row.meta
          ? { meta: JSON.parse(row.meta) as Readonly<Record<string, unknown>> }
          : {}),
      }));
    },

    async listRefs() {
      return selectAllRefs.all() as unknown as MediaRefRecord[];
    },

    async listByMetadata(sessionId, filter) {
      return filterAssetsByMetadata(await this.listAssets(), sessionId, filter);
    },

    async cleanup(protectedIds, policy) {
      if (!policy?.dryRun && sqlite.isTransaction)
        throw new Error(
          "SQLite media cleanup must run outside an existing SQL transaction",
        );
      const inventory = await this.listAssets();
      const { result, idsToDelete } = cleanupCandidates(
        inventory,
        claimedMediaIds(protectedIds, inventory, await this.listRefs()),
        policy,
      );
      if (!policy?.dryRun) {
        const deletedIds: string[] = [];
        for (const id of idsToDelete) {
          // BEGIN IMMEDIATE excludes another process's addRef/ownership write
          // across the final check and asset deletion.
          const path = deleteUnreferencedAsset(id);
          if (path === null) continue;
          deletedIds.push(id);
        }
        return finalizeMediaCleanupResult(result, inventory, deletedIds);
      }
      return result;
    },

    async openReadStream(ref) {
      const row = select.get(ref.id) as { path: string } | undefined;
      if (!row) throw new Error(`Media asset not found: ${ref.id}`);
      // Node 22+ exposes Readable.toWeb; Covel's engines field requires Node ≥ 22.
      const nodeStream = createReadStream(row.path);
      return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
    },

    close() {
      releaseSqliteConnection(sqlite);
    },
  };

  return { ...gate.gateWrites(store, MEDIA_WRITE_METHODS), put: store.put };
}

async function isReadable(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
