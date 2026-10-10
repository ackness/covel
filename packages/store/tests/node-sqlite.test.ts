// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as sqliteVec from "sqlite-vec";
import {
  loadSqliteExtension,
  openSqliteConnection,
  reclaimSqliteFreePages,
  runSqliteTransaction,
  type SqliteConnection,
} from "../src/sqlite/node-sqlite.js";

let db: SqliteConnection;
const names = () =>
  (
    db.prepare("SELECT name FROM t ORDER BY name").all() as { name: string }[]
  ).map((row) => row.name);

beforeEach(() => {
  db = openSqliteConnection(":memory:");
  db.exec("CREATE TABLE t (name TEXT PRIMARY KEY)");
});
afterEach(() => db.close());

describe("runSqliteTransaction", () => {
  it("commits, and rolls back everything when the callback throws", () => {
    runSqliteTransaction(db, () => {
      db.prepare("INSERT INTO t VALUES ('a')").run();
    });
    expect(() =>
      runSqliteTransaction(db, () => {
        db.prepare("INSERT INTO t VALUES ('b')").run();
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(names()).toEqual(["a"]);
    expect(db.isTransaction).toBe(false);
  });

  it("nests as a savepoint, so an inner failure keeps the outer writes", () => {
    runSqliteTransaction(
      db,
      () => {
        db.prepare("INSERT INTO t VALUES ('outer')").run();
        expect(() =>
          runSqliteTransaction(db, () => {
            db.prepare("INSERT INTO t VALUES ('inner')").run();
            throw new Error("inner");
          }),
        ).toThrow("inner");
        expect(db.isTransaction).toBe(true);
      },
      "immediate",
    );
    expect(names()).toEqual(["outer"]);
  });

  it("rejects an async callback and rolls back what it wrote", () => {
    expect(() =>
      runSqliteTransaction(db, async () => {
        db.prepare("INSERT INTO t VALUES ('async')").run();
      }),
    ).toThrow(/must not be async/);
    expect(names()).toEqual([]);
    expect(db.isTransaction).toBe(false);
  });
});

describe("reclaimSqliteFreePages", () => {
  const pages = (conn: SqliteConnection) =>
    (conn.prepare("PRAGMA page_count").get() as { page_count: number })
      .page_count;
  const fillAndEmpty = (conn: SqliteConnection) => {
    conn.exec("CREATE TABLE big (v TEXT)");
    const insert = conn.prepare("INSERT INTO big VALUES (?)");
    for (let i = 0; i < 300; i++) insert.run("x".repeat(4000));
    const full = pages(conn);
    conn.exec("DELETE FROM big");
    return full;
  };

  it("gives pages back in a new file and leaves an older file alone", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "covel-vacuum-"));
    try {
      const fresh = openSqliteConnection(path.join(dir, "fresh.db"));
      const full = fillAndEmpty(fresh);
      reclaimSqliteFreePages(fresh);
      expect(pages(fresh)).toBeLessThan(full / 2);
      fresh.close();

      // A file made before incremental auto-vacuum keeps its size.
      const legacy = new DatabaseSync(path.join(dir, "legacy.db"));
      const legacyFull = fillAndEmpty(legacy);
      reclaimSqliteFreePages(legacy);
      expect(pages(legacy)).toBe(legacyFull);
      legacy.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("loadSqliteExtension", () => {
  it("loads sqlite-vec and leaves extension loading disabled", () => {
    loadSqliteExtension(db, sqliteVec.load);
    expect(db.prepare("SELECT vec_version() AS v").get()).toMatchObject({
      v: expect.stringMatching(/^v/),
    });
    expect(() => db.loadExtension(sqliteVec.getLoadablePath())).toThrow();
  });
});
