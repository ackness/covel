/**
 * Schema ↔ DDL index-consistency guard.
 *
 * The store defines each table's shape twice per SQL backend:
 *   - hand-written DDL (`sqlite/sqlite-schema-ddl.ts`, `postgres/pg-schema-ddl.ts`)
 *     — this is what actually runs at boot (`createTables` / `client.unsafe`).
 *   - Drizzle ORM schema (`sqlite/schema.ts`, `postgres/schema.ts`)
 *     — the design-intent source consumed by tooling / migrations.
 *
 * These two drifted historically (PG `trace_events` was missing its
 * `trace_id` / `turn_id` indexes; several SQLite indexes used an
 * `idx_<table>_session` name while Drizzle used `<table>_<col>_idx`).
 *
 * This test pins the two representations together so future drift fails CI:
 *   1. Coverage parity — the set of `(unique, ordered-columns)` indexes per
 *      table must be identical. Catches a missing/extra index regardless of
 *      its name (this is what guards the PG `trace_events` regression).
 *   2. Non-unique name parity — every non-unique secondary index must have
 *      the same NAME → columns mapping. Catches naming drift like
 *      `idx_turn_messages_session` vs `turn_messages_session_id_idx`.
 *
 * Backends:
 *   - SQLite: the DDL is executed against an in-memory database and the real
 *     index set is read back from `PRAGMA index_list` / `PRAGMA index_info`.
 *   - PostgreSQL: spinning a real PG is out of scope here, so the DDL string is
 *     parsed statically (CREATE INDEX statements + inline UNIQUE constraints)
 *     and compared against the Drizzle schema.
 *
 * Known limitation: an inline `UNIQUE (...)` table constraint and a named
 * `uniqueIndex(...)` are semantically equivalent but carry different index
 * names (SQLite auto-names them `sqlite_autoindex_*`). Unique indexes are
 * therefore compared on coverage only, not name. All real-world naming drift
 * to date has been on non-unique secondary indexes, which ARE name-checked.
 */

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";

import { createTables } from "../src/sqlite/sqlite-schema-ddl.js";
import { CREATE_TABLES_SQL } from "../src/postgres/pg-schema-ddl.js";
import * as sqliteSchema from "../src/sqlite/schema.js";
import * as pgSchema from "../src/postgres/schema.js";

import { is } from "drizzle-orm";
import {
  SQLiteTable,
  getTableConfig as getSqliteTableConfig,
} from "drizzle-orm/sqlite-core";
import {
  PgTable,
  getTableConfig as getPgTableConfig,
} from "drizzle-orm/pg-core";

// ── Shared model ────────────────────────────────────────────────

interface IndexInfo {
  name: string;
  unique: boolean;
  columns: string[]; // ordered — index column order is significant
}

/** tableName → secondary indexes (primary-key indexes excluded). */
type TableIndexes = Map<string, IndexInfo[]>;

const coverageKey = (i: IndexInfo): string =>
  `${i.unique ? "U" : "I"}:${i.columns.join(",")}`;

/**
 * Compare an `expected` (Drizzle) spec against an `actual` (DDL) spec and
 * return a list of human-readable discrepancies. Empty list = consistent.
 */
function diffIndexSpecs(
  expected: TableIndexes,
  actual: TableIndexes,
): string[] {
  const problems: string[] = [];

  const expectedTables = new Set(expected.keys());
  const actualTables = new Set(actual.keys());

  for (const t of expectedTables) {
    if (!actualTables.has(t)) {
      problems.push(
        `table "${t}" declared in Drizzle schema but absent in DDL`,
      );
    }
  }
  for (const t of actualTables) {
    if (!expectedTables.has(t)) {
      problems.push(`table "${t}" present in DDL but absent in Drizzle schema`);
    }
  }

  for (const t of expectedTables) {
    if (!actualTables.has(t)) continue;
    const exp = expected.get(t)!;
    const act = actual.get(t)!;

    // 1. Coverage parity (unique + ordered columns), name-agnostic.
    const expCov = new Set(exp.map(coverageKey));
    const actCov = new Set(act.map(coverageKey));
    for (const k of expCov) {
      if (!actCov.has(k)) {
        problems.push(
          `[${t}] index coverage ${k} declared in Drizzle but missing in DDL`,
        );
      }
    }
    for (const k of actCov) {
      if (!expCov.has(k)) {
        problems.push(
          `[${t}] index coverage ${k} present in DDL but missing in Drizzle`,
        );
      }
    }

    // 2. Non-unique secondary-index NAME parity.
    const expNames = new Map(
      exp.filter((i) => !i.unique).map((i) => [i.name, i.columns.join(",")]),
    );
    const actNames = new Map(
      act.filter((i) => !i.unique).map((i) => [i.name, i.columns.join(",")]),
    );
    for (const [name, cols] of expNames) {
      if (!actNames.has(name)) {
        problems.push(
          `[${t}] non-unique index "${name}" (${cols}) declared in Drizzle but missing/renamed in DDL`,
        );
      } else if (actNames.get(name) !== cols) {
        problems.push(
          `[${t}] non-unique index "${name}" columns differ: Drizzle=(${cols}) DDL=(${actNames.get(name)})`,
        );
      }
    }
    for (const [name, cols] of actNames) {
      if (!expNames.has(name)) {
        problems.push(
          `[${t}] non-unique index "${name}" (${cols}) present in DDL but missing/renamed in Drizzle`,
        );
      }
    }
  }

  return problems;
}

// ── Drizzle extractors ──────────────────────────────────────────

function drizzleSqliteIndexes(): TableIndexes {
  const map: TableIndexes = new Map();
  for (const value of Object.values(sqliteSchema)) {
    if (!is(value, SQLiteTable)) continue;
    const cfg = getSqliteTableConfig(value);
    map.set(
      cfg.name,
      cfg.indexes.map((idx) => ({
        name: idx.config.name,
        unique: Boolean(idx.config.unique),
        columns: idx.config.columns.map(
          (c) => (c as { name?: string }).name ?? String(c),
        ),
      })),
    );
  }
  return map;
}

function drizzlePgIndexes(): TableIndexes {
  const map: TableIndexes = new Map();
  for (const value of Object.values(pgSchema)) {
    if (!is(value, PgTable)) continue;
    const cfg = getPgTableConfig(value);
    map.set(
      cfg.name,
      cfg.indexes.map((idx) => ({
        name: idx.config.name ?? "",
        unique: Boolean(idx.config.unique),
        columns: idx.config.columns.map(
          (c) => (c as { name?: string }).name ?? String(c),
        ),
      })),
    );
  }
  return map;
}

// ── Actual-DDL extractors ───────────────────────────────────────

function sqliteActualIndexes(): TableIndexes {
  const db = new Database(":memory:");
  try {
    createTables(db);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as Array<{ name: string }>;

    const map: TableIndexes = new Map();
    for (const { name: table } of tables) {
      const indexList = db
        .prepare(`PRAGMA index_list("${table}")`)
        .all() as Array<{ name: string; unique: number; origin: string }>;
      const indexes: IndexInfo[] = [];
      for (const il of indexList) {
        // Exclude primary-key auto-indexes (Drizzle does not model these as
        // indexes). Keep origin 'c' (CREATE INDEX) and 'u' (inline UNIQUE).
        if (il.origin === "pk") continue;
        const cols = (
          db.prepare(`PRAGMA index_info("${il.name}")`).all() as Array<{
            name: string | null;
          }>
        )
          .map((r) => r.name)
          .filter((n): n is string => n !== null);
        indexes.push({ name: il.name, unique: il.unique === 1, columns: cols });
      }
      map.set(table, indexes);
    }
    return map;
  } finally {
    db.close();
  }
}

function pgActualIndexes(sql: string): TableIndexes {
  const map: TableIndexes = new Map();

  // CREATE TABLE blocks → register table + inline UNIQUE (...) constraints.
  const tableRe =
    /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)\s*\(([\s\S]*?)\);/gi;
  let tm: RegExpExecArray | null;
  while ((tm = tableRe.exec(sql)) !== null) {
    const table = tm[1];
    const body = tm[2];
    if (!map.has(table)) map.set(table, []);
    const uniqueRe = /\bUNIQUE\s*\(([^)]+)\)/gi;
    let um: RegExpExecArray | null;
    while ((um = uniqueRe.exec(body)) !== null) {
      const cols = um[1].split(",").map((c) => c.trim());
      map.get(table)!.push({
        name: `<inline_unique:${table}>`,
        unique: true,
        columns: cols,
      });
    }
  }

  // CREATE [UNIQUE] INDEX statements (live outside CREATE TABLE bodies).
  const indexRe =
    /CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+ON\s+(\w+)\s*\(([^)]+)\)/gi;
  let im: RegExpExecArray | null;
  while ((im = indexRe.exec(sql)) !== null) {
    const unique = Boolean(im[1]);
    const name = im[2];
    const table = im[3];
    const cols = im[4].split(",").map((c) => c.trim());
    if (!map.has(table)) map.set(table, []);
    map.get(table)!.push({ name, unique, columns: cols });
  }

  return map;
}

// ── Tests ───────────────────────────────────────────────────────

describe("schema/DDL index consistency", () => {
  it("SQLite DDL index set matches the Drizzle schema", () => {
    const problems = diffIndexSpecs(
      drizzleSqliteIndexes(),
      sqliteActualIndexes(),
    );
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("PostgreSQL DDL index set matches the Drizzle schema", () => {
    const problems = diffIndexSpecs(
      drizzlePgIndexes(),
      pgActualIndexes(CREATE_TABLES_SQL),
    );
    expect(problems, problems.join("\n")).toEqual([]);
  });

  // Self-check: the guard must actually flag drift, otherwise it is useless.
  it("detects a missing index (deletion)", () => {
    const expected = drizzleSqliteIndexes();
    const broken = sqliteActualIndexes();
    // Drop trace_events' trace_id index to simulate the original PG regression.
    broken.set(
      "trace_events",
      broken
        .get("trace_events")!
        .filter((i) => i.columns.join(",") !== "session_id,trace_id"),
    );
    const problems = diffIndexSpecs(expected, broken);
    expect(problems.some((p) => p.includes("trace_events"))).toBe(true);
  });

  it("detects a renamed non-unique index", () => {
    const expected = drizzleSqliteIndexes();
    const broken = sqliteActualIndexes();
    broken.set(
      "turn_messages",
      broken
        .get("turn_messages")!
        .map((i) =>
          i.name === "turn_messages_session_id_idx"
            ? { ...i, name: "idx_turn_messages_session" }
            : i,
        ),
    );
    const problems = diffIndexSpecs(expected, broken);
    expect(problems.some((p) => p.includes("turn_messages"))).toBe(true);
  });
});
