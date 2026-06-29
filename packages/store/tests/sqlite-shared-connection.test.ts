import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteStore } from "../src/sqlite/sqlite-store.js";
import { createSqliteMediaStore } from "../src/media-store/sqlite.js";
import {
  acquireSqliteConnection,
  releaseSqliteConnection,
} from "../src/sqlite/shared-connection.js";

describe("sqlite shared connection", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "covel-shared-conn-"));
    dbPath = path.join(dir, "covel.db");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("lets the mirror media store write inside the main store's transaction without deadlocking", async () => {
    const store = createSqliteStore(dbPath);
    const media = createSqliteMediaStore(dbPath);
    try {
      const bytes = new Uint8Array([1, 2, 3, 4]);

      // Before the shared-connection fix this threw SQLITE_BUSY after ~5s: the
      // media store's separate connection could not acquire the write lock the
      // open `withTransaction` held — the exact deadlock that turned a
      // portrait-carrying world's POST /api/sessions into a 500.
      const ref = await store.withTransaction!(async (tx) => {
        await tx.createSession({
          id: "s1",
          worldId: "w",
          status: "active",
          turnCount: 0,
          preGameCompleted: [],
          locale: "zh-CN",
          activePlugins: [],
          createdAt: "2026-06-29T00:00:00.000Z",
          updatedAt: "2026-06-29T00:00:00.000Z",
        });
        return media.put(bytes, "image/png");
      });

      expect(ref.id).toMatch(/^[0-9a-f]{64}$/);
      // The media asset and the session committed together with the tx.
      expect(await media.exists(ref.id)).toBe(true);
      expect(await store.getSession("s1")).toBeTruthy();
    } finally {
      await media.close?.();
      await store.close();
    }
  });

  it("shares one connection per file path and closes on the last release", () => {
    const a = acquireSqliteConnection(dbPath);
    const b = acquireSqliteConnection(dbPath);
    expect(b).toBe(a); // same handle, refcount now 2

    releaseSqliteConnection(a); // 2 -> 1, still open
    expect(a.open).toBe(true);

    releaseSqliteConnection(b); // 1 -> 0, closed
    expect(a.open).toBe(false);
  });

  it("never shares :memory: connections", () => {
    const a = acquireSqliteConnection(":memory:");
    const b = acquireSqliteConnection(":memory:");
    expect(b).not.toBe(a);
    releaseSqliteConnection(a);
    releaseSqliteConnection(b);
  });
});
