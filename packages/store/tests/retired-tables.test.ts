import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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
    const legacy = new DatabaseSync(dbPath);
    legacy.exec("CREATE TABLE runtime_results (id TEXT PRIMARY KEY)");
    legacy.close();

    const store = createSqliteStore(dbPath);
    await store.close();

    const reopened = new DatabaseSync(dbPath);
    const tables = reopened
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    reopened.close();
    expect(tables.map((table) => table.name)).not.toContain("runtime_results");
    expect(tables.map((table) => table.name)).toContain("turn_results");
  });

  it("deletes rows of retired plugin-data namespaces at boot", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "covel-retired-"));
    dirs.push(dir);
    const dbPath = path.join(dir, "covel.db");
    const first = createSqliteStore(dbPath);
    for (const namespace of ["_jobs", "notes"]) {
      await first.setPluginData({
        id: `s:p:${namespace}:k`,
        sessionId: "s",
        pluginId: "p",
        namespace,
        key: "k",
        value: { status: "pending" },
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
      });
    }
    await first.close();

    const store = createSqliteStore(dbPath);
    expect(
      (await store.listPluginDataSessionScope("s")).map((row) => row.namespace),
    ).toEqual(["notes"]);
    await store.close();
  });
});
