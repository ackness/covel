import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runMediaStoreContractTests } from "../src/contract/media-store-contract.js";
import {
  createMemoryMediaStore,
  createPgMediaStore,
  createSqliteMediaStore,
} from "../src/media-store.js";
import {
  acquireSqliteConnection,
  releaseSqliteConnection,
} from "../src/sqlite/shared-connection.js";

runMediaStoreContractTests("MemoryMediaStore", () => createMemoryMediaStore());

runMediaStoreContractTests("SqliteMediaStore", () => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "covel-media-store-test-"),
  );
  return createSqliteMediaStore(path.join(tmpDir, "test.db"), {
    mediaRoot: path.join(tmpDir, "media"),
  });
});

describe("SqliteMediaStore transaction boundaries", () => {
  it("removes refs and the asset inside one SQLite transaction", async () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "covel-media-delete-tx-"),
    );
    const dbPath = path.join(tmpDir, "test.db");
    const store = createSqliteMediaStore(dbPath, {
      mediaRoot: path.join(tmpDir, "media"),
    });
    const sqlite = acquireSqliteConnection(dbPath);
    let deleteObservedInTransaction = false;
    sqlite.function("covel_observe_media_delete_tx", () => {
      deleteObservedInTransaction = sqlite.isTransaction;
      return null;
    });
    sqlite.exec(`
      CREATE TEMP TRIGGER observe_media_delete_tx
      AFTER DELETE ON media_refs
      BEGIN
        SELECT covel_observe_media_delete_tx();
      END
    `);

    try {
      const ref = await store.put(new Uint8Array([1, 2, 3]), "image/png");
      await store.addRef(ref.id, "sess-delete", "plugin-delete");
      await store.delete(ref.id);

      expect(deleteObservedInTransaction).toBe(true);
      expect(await store.exists(ref.id)).toBe(false);
      expect(await store.listRefs()).toEqual([]);
    } finally {
      sqlite.exec("DROP TRIGGER IF EXISTS observe_media_delete_tx");
      releaseSqliteConnection(sqlite);
      await store.close?.();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("SqliteMediaStore claimAssets", () => {
  it("rolls back every claim of the batch when a later write fails", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "covel-media-claim-"));
    const dbPath = path.join(tmpDir, "test.db");
    const store = createSqliteMediaStore(dbPath, {
      mediaRoot: path.join(tmpDir, "media"),
    });
    const sqlite = acquireSqliteConnection(dbPath);
    try {
      const first = await store.put(new Uint8Array([1]), "image/png");
      const second = await store.put(new Uint8Array([2]), "image/png");
      await store.addRef(second.id, "sess-other", "plugin-other");
      // The second claim's ref insert fails after the first claim was written.
      sqlite.exec(`
        CREATE TEMP TRIGGER fail_second_claim
        BEFORE INSERT ON media_refs
        WHEN NEW.media_id = '${second.id}' AND NEW.session_id = 'sess-1'
        BEGIN
          SELECT RAISE(ABORT, 'synthetic claim failure');
        END
      `);

      await expect(
        store.claimAssets([
          { id: first.id, sessionId: "sess-1", pluginId: "plugin" },
          { id: second.id, sessionId: "sess-1", pluginId: "plugin" },
        ]),
      ).rejects.toThrow("synthetic claim failure");

      expect((await store.lookup(first.id))?.ownerSessionId).toBeNull();
      expect((await store.lookup(second.id))?.ownerSessionId).toBeNull();
      expect(
        (await store.listRefs()).map((row) => [row.mediaId, row.sessionId]),
      ).toEqual([[second.id, "sess-other"]]);
    } finally {
      sqlite.exec("DROP TRIGGER IF EXISTS fail_second_claim");
      releaseSqliteConnection(sqlite);
      await store.close?.();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://covel:covel_dev@localhost:5432/covel";
const REQUIRE_PG = process.env.COVEL_REQUIRE_PG_TESTS === "1";

let pgAvailable = false;
try {
  const { default: postgres } = await import("postgres");
  const client = postgres(DATABASE_URL, { connect_timeout: 3 });
  await client`SELECT 1`;
  await client.end();
  pgAvailable = true;
} catch (error) {
  if (REQUIRE_PG) {
    throw new Error("PostgreSQL is required for PgMediaStore tests", {
      cause: error,
    });
  }
  console.warn("PostgreSQL not available, skipping PgMediaStore tests");
}

if (pgAvailable) {
  const { createIsolatedPgDatabase } = await import("./pg-test-db.js");
  // Own database so this file never races concurrent PG test files on schema DDL.
  const isolated = await createIsolatedPgDatabase(
    DATABASE_URL,
    "covel_test_media",
  );
  afterAll(() => isolated.cleanup());

  runMediaStoreContractTests("PgMediaStore", () =>
    createPgMediaStore(isolated.url, { freshSchema: true }),
  );
  describe("PgMediaStore claimAssets", () => {
    it("rolls back every claim of the batch when a later write fails", async () => {
      const { default: postgres } = await import("postgres");
      const store = await createPgMediaStore(isolated.url, {
        freshSchema: true,
      });
      const admin = postgres(isolated.url, { max: 1, onnotice: () => {} });
      try {
        const first = await store.put(new Uint8Array([1]), "image/png");
        const second = await store.put(new Uint8Array([2]), "image/png");
        await store.addRef(second.id, "sess-other", "plugin-other");
        // The second claim's ref insert fails after the first claim was written.
        await admin.unsafe(`
          CREATE FUNCTION covel_test_fail_claim() RETURNS trigger AS $$
          BEGIN
            IF NEW.media_id = '${second.id}' AND NEW.session_id = 'sess-1' THEN
              RAISE EXCEPTION 'synthetic claim failure';
            END IF;
            RETURN NEW;
          END $$ LANGUAGE plpgsql;
          CREATE TRIGGER covel_test_fail_claim BEFORE INSERT ON media_refs
          FOR EACH ROW EXECUTE FUNCTION covel_test_fail_claim();
        `);

        await expect(
          store.claimAssets([
            { id: first.id, sessionId: "sess-1", pluginId: "plugin" },
            { id: second.id, sessionId: "sess-1", pluginId: "plugin" },
          ]),
        ).rejects.toThrow("synthetic claim failure");

        expect((await store.lookup(first.id))?.ownerSessionId).toBeNull();
        expect((await store.lookup(second.id))?.ownerSessionId).toBeNull();
        expect(
          (await store.listRefs()).map((row) => [row.mediaId, row.sessionId]),
        ).toEqual([[second.id, "sess-other"]]);
      } finally {
        await admin.unsafe(`
          DROP TRIGGER IF EXISTS covel_test_fail_claim ON media_refs;
          DROP FUNCTION IF EXISTS covel_test_fail_claim();
        `);
        await admin.end();
        await store.close?.();
      }
    });
  });

  describe("PgMediaStore cleanup serialization", () => {
    it("holds the per-asset advisory lock across expired-ref release and asset deletion", async () => {
      const { default: postgres } = await import("postgres");
      const hour = 60 * 60 * 1000;
      const store = await createPgMediaStore(isolated.url, {
        freshSchema: true,
      });
      const blocker = postgres(isolated.url, { max: 1, onnotice: () => {} });
      const observer = postgres(isolated.url, { max: 1, onnotice: () => {} });
      let releaseOrphan!: () => void;
      let releaseShared!: () => void;
      let orphanBlockingTx: Promise<unknown> | undefined;
      let sharedBlockingTx: Promise<unknown> | undefined;
      try {
        const holder = "world-data-import:abandoned";
        const orphan = await store.put(
          new Uint8Array([10, 20, 30]),
          "image/png",
          undefined,
          { sessionId: holder, pluginId: "p1" },
        );
        const shared = await store.put(
          new Uint8Array([40, 50, 60]),
          "image/png",
          undefined,
          { sessionId: holder, pluginId: "p1" },
        );
        await store.addRef(shared.id, "sess-live", "p-live");

        const cleanupTime = new Date(Date.now() + 25 * hour);
        const refreshedAt = cleanupTime.toISOString();
        const policy = {
          maxAgeMs: 0,
          expireRefs: {
            sessionIdPrefix: "world-data-import:",
            maxAgeMs: 24 * hour,
          },
          now: cleanupTime,
        };

        // 1. Block orphan's per-asset advisory lock, start cleanup, verify
        // expired ref is NOT deleted outside the lock, then refresh created_at
        // inside the lock (simulating a concurrent re-claim winning the lock).
        let markOrphanLocked!: () => void;
        const orphanLocked = new Promise<void>((resolve) => {
          markOrphanLocked = resolve;
        });
        const holdOrphan = new Promise<void>((resolve) => {
          releaseOrphan = resolve;
        });
        orphanBlockingTx = blocker.begin(async (tx) => {
          await tx`SELECT pg_advisory_xact_lock(1129270860, hashtext(${orphan.id}))`;
          markOrphanLocked();
          await holdOrphan;
          await tx`
            INSERT INTO media_refs (session_id, media_id, plugin_id, created_at)
            VALUES (${holder}, ${orphan.id}, ${"p2"}, ${refreshedAt})
            ON CONFLICT (session_id, media_id) DO UPDATE SET created_at = EXCLUDED.created_at
          `;
        });
        await orphanLocked;

        const firstCleanup = store.cleanup(new Set(), policy);
        await new Promise((resolve) => setTimeout(resolve, 60));

        // While the advisory lock is held, cleanup must not have released the
        // expired ref for orphan.
        const refsDuringLock = await observer<{ created_at: string }[]>`
          SELECT created_at FROM media_refs
          WHERE media_id = ${orphan.id} AND session_id = ${holder}
        `;
        expect(refsDuringLock).toHaveLength(1);

        releaseOrphan();
        await orphanBlockingTx;
        const firstResult = await firstCleanup;

        // Because the re-claim refreshed created_at before cleanup acquired the
        // lock, cleanup must keep both the refreshed ref and the orphan asset,
        // while releasing shared's expired ref.
        expect(firstResult.deletedIds).toEqual([]);
        expect(firstResult.expiredRefs).toEqual([
          expect.objectContaining({ mediaId: shared.id, sessionId: holder }),
        ]);
        expect(await store.exists(orphan.id)).toBe(true);
        expect(await store.exists(shared.id)).toBe(true);
        expect(
          (await store.listRefs()).find(
            (r) => r.mediaId === orphan.id && r.sessionId === holder,
          ),
        ).toMatchObject({ pluginId: "p1", createdAt: refreshedAt });

        // 2. Also verify an expired-ref-only asset (not in idsToDelete) holds
        // the per-asset advisory lock before deleting its expired ref.
        await store.addRef(shared.id, holder, "p1");
        const secondCleanupTime = new Date(cleanupTime.getTime() + 25 * hour);
        let markSharedLocked!: () => void;
        const sharedLocked = new Promise<void>((resolve) => {
          markSharedLocked = resolve;
        });
        const holdShared = new Promise<void>((resolve) => {
          releaseShared = resolve;
        });
        sharedBlockingTx = blocker.begin(async (tx) => {
          await tx`SELECT pg_advisory_xact_lock(1129270860, hashtext(${shared.id}))`;
          markSharedLocked();
          await holdShared;
        });
        await sharedLocked;

        const secondCleanup = store.cleanup(new Set(), {
          ...policy,
          now: secondCleanupTime,
        });
        await new Promise((resolve) => setTimeout(resolve, 60));
        const sharedRefsDuringLock = await observer<{ session_id: string }[]>`
          SELECT session_id FROM media_refs
          WHERE media_id = ${shared.id} AND session_id = ${holder}
        `;
        expect(sharedRefsDuringLock).toHaveLength(1);

        releaseShared();
        await sharedBlockingTx;
        const secondResult = await secondCleanup;
        expect(secondResult.expiredRefs).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ mediaId: shared.id, sessionId: holder }),
          ]),
        );
        expect(await store.exists(shared.id)).toBe(true);
        expect(await store.isReferencedBy(shared.id, "sess-live")).toBe(true);
        expect(await store.isReferencedBy(shared.id, holder)).toBe(false);
      } finally {
        releaseOrphan?.();
        releaseShared?.();
        await orphanBlockingTx?.catch(() => undefined);
        await sharedBlockingTx?.catch(() => undefined);
        await Promise.all([blocker.end(), observer.end(), store.close?.()]);
      }
    });
  });

  describe("PgMediaStore lifecycle", () => {
    it("exposes an idempotent close for its owned client", async () => {
      const store = await createPgMediaStore(isolated.url);
      expect(store.close).toEqual(expect.any(Function));
      await store.close?.();
      await store.close?.();
    });
  });
} else {
  describe("PgMediaStore (skipped)", () => {
    it.skip("skipped — PostgreSQL not available", () => {});
  });
}
