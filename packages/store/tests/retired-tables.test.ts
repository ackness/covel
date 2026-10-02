import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { createSqliteStore } from "../src/sqlite/sqlite-store.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

describe("retired tables", () => {
  it("drops runtime_results left in an existing SQLite database at boot", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "covel-retired-"));
    dirs.push(dir);
    const dbPath = path.join(dir, "covel.db");
    const legacy = new Database(dbPath);
    legacy.exec("CREATE TABLE runtime_results (id TEXT PRIMARY KEY)");
    legacy.close();

    const store = createSqliteStore(dbPath);
    await store.close();

    const reopened = new Database(dbPath);
    const tables = reopened
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    reopened.close();
    expect(tables.map((table) => table.name)).not.toContain("runtime_results");
    expect(tables.map((table) => table.name)).toContain("turn_results");
  });
});
