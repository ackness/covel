import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { buildCreateTablesSql } from "../src/common/ddl-codegen.js";
import { StoreSchemaVersionError } from "../src/errors.js";
import { DATA_SCHEMA_VERSION } from "../src/migrations.js";
import * as pgSchema from "../src/postgres/schema.js";
import * as sqliteSchema from "../src/sqlite/schema.js";
import { createSqliteStore } from "../src/sqlite/sqlite-store.js";
import { runSchemaVersionTests } from "./schema-version-suite.js";

function withFile<T>(dbPath: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

runSchemaVersionTests("SqliteStore", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "covel-schema-version-"));
  const dbPath = path.join(dir, "covel.db");
  return {
    async reset() {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
    },
    async open() {
      return createSqliteStore(dbPath);
    },
    async recordedVersion() {
      return withFile(dbPath, (db) => {
        const row = db.prepare("PRAGMA user_version").get() as {
          user_version: number;
        };
        return row.user_version === 0 ? null : row.user_version;
      });
    },
    async setRecordedVersion(version) {
      withFile(dbPath, (db) =>
        db.exec(`PRAGMA user_version = ${version ?? 0}`),
      );
    },
    async replaceWorldsWithOldTable() {
      withFile(dbPath, (db) =>
        db.exec(
          "DROP TABLE worlds; CREATE TABLE worlds (id TEXT PRIMARY KEY);",
        ),
      );
    },
    async worldsColumns() {
      return withFile(dbPath, (db) =>
        (
          db.prepare('PRAGMA table_info("worlds")').all() as { name: string }[]
        ).map((row) => row.name),
      );
    },
  };
});

/**
 * The table shapes (columns, types, defaults, keys; not indexes, which the boot
 * DDL adds to an existing table) recorded for {@link DATA_SCHEMA_VERSION}.
 */
const PINNED_SHAPES = {
  version: 8,
  sqlite: "4821bac0a9824b3ca970342b944a6b6d661449fb56944c828de5ae33bf37d0fa",
  pg: "d4679eb1187d1409a2babe655a0f3dc4bfcfddf83d6f42e2b5f9ff47b063c4f4",
};

function shapeDigest(tables: readonly unknown[], dialect: "sqlite" | "pg") {
  const shape = buildCreateTablesSql(tables, dialect)
    .split("\n")
    .filter((line) => !/^CREATE (UNIQUE )?INDEX/.test(line))
    .join("\n");
  return createHash("sha256").update(shape).digest("hex");
}

const refusedVersions = [
  null,
  DATA_SCHEMA_VERSION - 1,
  DATA_SCHEMA_VERSION + 1,
];

describe("data schema version", () => {
  it("refuses data schema 7", () => {
    expect(refusedVersions).toContain(7);
  });

  it.each(refusedVersions)(
    "names the absolute SQLite path when refusing schema %s",
    (version) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "covel-schema-path-"));
      const dbPath = path.join(dir, "covel.db");
      withFile(dbPath, (db) => {
        db.exec("CREATE TABLE worlds (id TEXT PRIMARY KEY)");
        db.exec(`PRAGMA user_version = ${version ?? 0}`);
      });

      expect(() =>
        createSqliteStore(path.relative(process.cwd(), dbPath)),
      ).toThrow(
        expect.objectContaining({
          name: StoreSchemaVersionError.name,
          database: fs.realpathSync(dbPath),
          message: expect.stringContaining(fs.realpathSync(dbPath)),
        }),
      );
    },
  );

  it("changes together with the table shapes", () => {
    // A failure here means a table shape changed. When an existing database
    // cannot follow the change (a column added, removed, renamed or retyped on
    // an existing table), raise DATA_SCHEMA_VERSION in src/migrations.ts so
    // older databases are refused instead of failing on a missing column.
    // Then record the new digests and version here.
    expect({
      version: DATA_SCHEMA_VERSION,
      sqlite: shapeDigest(Object.values(sqliteSchema), "sqlite"),
      pg: shapeDigest(Object.values(pgSchema), "pg"),
    }).toEqual(PINNED_SHAPES);
  });
});
