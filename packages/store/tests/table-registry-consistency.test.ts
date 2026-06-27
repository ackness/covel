/**
 * Session-table registry consistency guard.
 *
 * The registry (`src/table-registry.ts`) is the single source of truth that
 * drives the cascade-delete modules, the PG drop list, and the MemoryStore
 * cascade + transaction snapshot. This test pins it against the three
 * representations it claims to derive, so the moment someone adds a
 * `session_id` table to the schema (or a session-scoped MemoryState collection)
 * without registering it, CI fails — exactly the silent-drift class of bug the
 * registry exists to prevent.
 */

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { getTableName, is } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { PgTable } from "drizzle-orm/pg-core";

import {
  SESSION_SCOPED_TABLES,
  SESSION_SCOPED_TABLE_NAMES,
  SESSIONS_TABLE,
} from "../src/table-registry.js";
import { createTables } from "../src/sqlite/sqlite-schema-ddl.js";
import { ALL_TABLE_NAMES } from "../src/postgres/pg-schema-ddl.js";
import { MEMORY_SNAPSHOT_COLLECTIONS } from "../src/memory/transaction-methods.js";
import { createMemoryState } from "../src/memory/memory-state.js";
import * as sqliteSchema from "../src/sqlite/schema.js";
import * as pgSchema from "../src/postgres/schema.js";

/**
 * Session-scoped SQL tables that intentionally do NOT participate in the
 * session-delete cascade (managed by a different subsystem). Adding to this set
 * is a deliberate, reviewed decision.
 */
const NON_CASCADE_SESSION_TABLES = new Set<string>([
  // media_refs carries session_id but is owned by MediaStore lifecycle, not the
  // session cascade.
  "media_refs",
]);

/** Tables (and their columns) created by the real SQLite DDL. */
function ddlTablesWithColumns(): Map<string, Set<string>> {
  const db = new Database(":memory:");
  try {
    createTables(db);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as Array<{ name: string }>;
    const map = new Map<string, Set<string>>();
    for (const { name } of tables) {
      const cols = (
        db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{
          name: string;
        }>
      ).map((c) => c.name);
      map.set(name, new Set(cols));
    }
    return map;
  } finally {
    db.close();
  }
}

function drizzleTableNames(
  schema: Record<string, unknown>,
  guard: (v: unknown) => boolean,
): Set<string> {
  const names = new Set<string>();
  for (const value of Object.values(schema)) {
    if (guard(value)) names.add(getTableName(value as never));
  }
  return names;
}

describe("table registry consistency", () => {
  const registryNames = new Set(SESSION_SCOPED_TABLE_NAMES);

  it("has no duplicate entries", () => {
    expect(registryNames.size).toBe(SESSION_SCOPED_TABLES.length);
  });

  it("registers every session_id table that the SQLite DDL creates", () => {
    const ddl = ddlTablesWithColumns();
    const missing: string[] = [];
    for (const [table, cols] of ddl) {
      if (table === SESSIONS_TABLE) continue; // parent, keyed by id
      if (!cols.has("session_id")) continue; // not session-scoped
      if (NON_CASCADE_SESSION_TABLES.has(table)) continue;
      if (!registryNames.has(table)) missing.push(table);
    }
    expect(
      missing,
      `tables have a session_id column but are absent from SESSION_SCOPED_TABLES: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("every registry table exists in the DDL with a session_id column", () => {
    const ddl = ddlTablesWithColumns();
    for (const { table } of SESSION_SCOPED_TABLES) {
      const cols = ddl.get(table);
      expect(
        cols,
        `registry table "${table}" is missing from the DDL`,
      ).toBeDefined();
      expect(
        cols!.has("session_id"),
        `registry table "${table}" has no session_id column`,
      ).toBe(true);
    }
  });

  it("matches the Drizzle SQLite and PG schemas", () => {
    const sqliteNames = drizzleTableNames(sqliteSchema, (v) =>
      is(v, SQLiteTable),
    );
    const pgNames = drizzleTableNames(pgSchema, (v) => is(v, PgTable));
    for (const { table } of SESSION_SCOPED_TABLES) {
      expect(
        sqliteNames.has(table),
        `${table} missing from sqlite schema`,
      ).toBe(true);
      expect(pgNames.has(table), `${table} missing from pg schema`).toBe(true);
    }
  });

  it("drives ALL_TABLE_NAMES (every registry table is in the drop list)", () => {
    const dropSet = new Set(ALL_TABLE_NAMES);
    expect(dropSet.has(SESSIONS_TABLE)).toBe(true);
    for (const { table } of SESSION_SCOPED_TABLES) {
      expect(dropSet.has(table), `${table} missing from ALL_TABLE_NAMES`).toBe(
        true,
      );
    }
  });

  it("maps every registry table to a MemoryState collection of the right kind", () => {
    const state = createMemoryState() as unknown as Record<string, unknown>;
    for (const { table, memoryKey, memoryKind } of SESSION_SCOPED_TABLES) {
      const collection = state[memoryKey];
      expect(
        collection,
        `MemoryState has no "${memoryKey}" for table "${table}"`,
      ).toBeDefined();
      if (memoryKind === "map") {
        expect(collection instanceof Map, `${memoryKey} should be a Map`).toBe(
          true,
        );
      } else {
        expect(
          Array.isArray(collection),
          `${memoryKey} should be an array`,
        ).toBe(true);
      }
    }
  });

  it("includes every registry collection in the MemoryStore tx snapshot", () => {
    const snapshotKeys = new Set(MEMORY_SNAPSHOT_COLLECTIONS.map((c) => c.key));
    expect(snapshotKeys.has("sessions")).toBe(true);
    for (const { memoryKey } of SESSION_SCOPED_TABLES) {
      expect(
        snapshotKeys.has(memoryKey),
        `snapshot is missing registry collection "${memoryKey}"`,
      ).toBe(true);
    }
  });
});
