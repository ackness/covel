// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as sqliteVec from "sqlite-vec";
import {
  loadSqliteExtension,
  openSqliteConnection,
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

describe("loadSqliteExtension", () => {
  it("loads sqlite-vec and leaves extension loading disabled", () => {
    loadSqliteExtension(db, sqliteVec.load);
    expect(db.prepare("SELECT vec_version() AS v").get()).toMatchObject({
      v: expect.stringMatching(/^v/),
    });
    expect(() => db.loadExtension(sqliteVec.getLoadablePath())).toThrow();
  });
});
