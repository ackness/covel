import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteStore } from "../src/sqlite/sqlite-store.js";
import { createSqliteMediaStore } from "../src/media-store/sqlite.js";
import {
  acquireSqliteConnection,
  releaseSqliteConnection,
} from "../src/sqlite/shared-connection.js";
import * as connections from "../src/sqlite/shared-connection.js";

describe("sqlite shared connection", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "covel-shared-conn-"));
    dbPath = path.join(dir, "covel.db");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("releases a failed media initialization without closing the existing data owner", async () => {
    const store = createSqliteStore(dbPath);
    const observed = acquireSqliteConnection(dbPath);
    releaseSqliteConnection(observed);
    const mediaRoot = path.join(dir, "blocked-media");
    await writeFile(mediaRoot, "synthetic fixture");
    let ownerClosed = false;
    try {
      expect(() => createSqliteMediaStore(dbPath, { mediaRoot })).toThrow(
        expect.objectContaining({ code: "EEXIST" }),
      );
      expect(observed.open).toBe(true);
      expect(await store.listSessions()).toEqual([]);
      await store.close();
      ownerClosed = true;
      expect(observed.open).toBe(false);
    } finally {
      if (!ownerClosed) await store.close();
      if (observed.open) releaseSqliteConnection(observed);
    }
  });

  it("closes the only acquired connection on initialization failure and permits a fresh owner", async () => {
    const acquire = connections.acquireSqliteConnection;
    let observed: ReturnType<typeof acquire> | undefined;
    const spy = vi
      .spyOn(connections, "acquireSqliteConnection")
      .mockImplementationOnce((file) => {
        observed = acquire(file);
        return observed;
      });
    const mediaRoot = path.join(dir, "blocked-media");
    await writeFile(mediaRoot, "synthetic fixture");
    try {
      expect(() => createSqliteMediaStore(dbPath, { mediaRoot })).toThrow(
        expect.objectContaining({ code: "EEXIST" }),
      );
      expect(observed).toBeDefined();
      expect(observed?.open).toBe(false);
      spy.mockRestore();

      const media = createSqliteMediaStore(dbPath, {
        mediaRoot: path.join(dir, "valid-media"),
      });
      try {
        const ref = await media.put(new Uint8Array([1, 2, 3]), "image/png");
        expect(await media.exists(ref.id)).toBe(true);
      } finally {
        await media.close?.();
      }
    } finally {
      spy.mockRestore();
      if (observed?.open) releaseSqliteConnection(observed);
    }
  });

  it("preserves a later initialization error while returning only the failed owner's reference", () => {
    const observed = acquireSqliteConnection(dbPath);
    const error = new Error("synthetic prepare failure");
    const prepare = vi.spyOn(observed, "prepare").mockImplementationOnce(() => {
      throw error;
    });
    let ownerReleased = false;
    try {
      let failure: unknown;
      try {
        createSqliteMediaStore(dbPath);
      } catch (caught) {
        failure = caught;
      }
      expect(failure).toBe(error);
      prepare.mockRestore();
      expect(observed.prepare("SELECT 1 AS value").get()).toEqual({ value: 1 });
      releaseSqliteConnection(observed);
      ownerReleased = true;
      expect(observed.open).toBe(false);
    } finally {
      prepare.mockRestore();
      if (!ownerReleased) releaseSqliteConnection(observed);
      if (observed.open) releaseSqliteConnection(observed);
    }
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
          phase: "setup",
          completedPlayerTurns: 0,
          setupRuntimes: {},
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
