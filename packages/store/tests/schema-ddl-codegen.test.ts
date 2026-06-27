/**
 * DDL codegen ↔ Drizzle parity + determinism guard.
 *
 * The boot DDL is generated from the Drizzle schema by `common/ddl-codegen.ts`.
 * These tests pin that derivation so the emitter cannot silently drift:
 *
 *   1. Determinism — generating twice yields byte-identical SQL, and the DDL
 *      actually shipped by each backend IS the generated string (no hand copy).
 *   2. SQLite column parity — booting the generated DDL produces, for every
 *      table, the exact column set / types / nullability / PK / default-presence
 *      declared in the Drizzle schema (read back via PRAGMA table_info).
 *   3. PostgreSQL column parity — same check against a real PG instance, gated
 *      on DATABASE_URL (information_schema.columns). Skipped when PG is absent.
 *
 * Index parity is covered separately by `schema-index-consistency.test.ts`.
 */

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { is } from "drizzle-orm";
import {
  SQLiteTable,
  getTableConfig as getSqliteConfig,
} from "drizzle-orm/sqlite-core";
import { PgTable, getTableConfig as getPgConfig } from "drizzle-orm/pg-core";

import { buildCreateTablesSql } from "../src/common/ddl-codegen.js";
import {
  CREATE_TABLES_SQL as SQLITE_DDL,
  createTables,
} from "../src/sqlite/sqlite-schema-ddl.js";
import { CREATE_TABLES_SQL as PG_DDL } from "../src/postgres/pg-schema-ddl.js";
import * as sqliteSchema from "../src/sqlite/schema.js";
import * as pgSchema from "../src/postgres/schema.js";

// ── Drizzle column model ────────────────────────────────────────

interface ExpectedColumn {
  type: string; // normalized SQL type, upper-case
  notNull: boolean;
  primary: boolean;
  hasDefault: boolean;
}

/** name → expected column, per table, from the SQLite Drizzle schema. */
function sqliteExpected(): Map<string, Map<string, ExpectedColumn>> {
  const map = new Map<string, Map<string, ExpectedColumn>>();
  for (const value of Object.values(sqliteSchema)) {
    if (!is(value, SQLiteTable)) continue;
    const cfg = getSqliteConfig(value);
    const cols = new Map<string, ExpectedColumn>();
    for (const c of cfg.columns) {
      cols.set(c.name, {
        type: c.getSQLType().toUpperCase(),
        notNull: c.notNull,
        primary: c.primary,
        hasDefault: c.hasDefault && c.default !== undefined,
      });
    }
    map.set(cfg.name, cols);
  }
  return map;
}

// ── Tests ───────────────────────────────────────────────────────

describe("DDL codegen ↔ Drizzle parity", () => {
  it("generates deterministic SQLite DDL equal to the shipped boot DDL", () => {
    const a = buildCreateTablesSql(Object.values(sqliteSchema), "sqlite");
    const b = buildCreateTablesSql(Object.values(sqliteSchema), "sqlite");
    expect(a).toBe(b);
    // The DDL the backend actually executes IS the generated string — proving
    // there is no separately-editable hand copy that could drift.
    expect(SQLITE_DDL).toBe(a);
  });

  it("generates deterministic PG core+media DDL embedded in the boot DDL", () => {
    const a = buildCreateTablesSql(Object.values(pgSchema), "pg");
    const b = buildCreateTablesSql(Object.values(pgSchema), "pg");
    expect(a).toBe(b);
    // Every generated CREATE TABLE statement must appear in the composed boot
    // DDL (which also carries the hand-written migrations + trigger).
    const createStmts = a.match(/CREATE TABLE IF NOT EXISTS \w+/g) ?? [];
    expect(createStmts.length).toBeGreaterThan(0);
    for (const stmt of createStmts) {
      expect(PG_DDL.includes(stmt), `boot DDL missing: ${stmt}`).toBe(true);
    }
  });

  it("SQLite generated DDL yields exactly the Drizzle column shape", () => {
    const expected = sqliteExpected();
    const db = new Database(":memory:");
    try {
      createTables(db);
      const problems: string[] = [];
      for (const [table, cols] of expected) {
        const info = db
          .prepare(`PRAGMA table_info("${table}")`)
          .all() as Array<{
          name: string;
          type: string;
          notnull: number;
          dflt_value: string | null;
          pk: number;
        }>;
        const actual = new Map(info.map((r) => [r.name, r]));

        for (const name of cols.keys()) {
          if (!actual.has(name)) {
            problems.push(`[${table}] column "${name}" missing in DDL`);
          }
        }
        for (const name of actual.keys()) {
          if (!cols.has(name)) {
            problems.push(
              `[${table}] column "${name}" present in DDL but not Drizzle`,
            );
          }
        }

        for (const [name, exp] of cols) {
          const got = actual.get(name);
          if (!got) continue;
          if (got.type.toUpperCase() !== exp.type) {
            problems.push(
              `[${table}.${name}] type DDL=${got.type} Drizzle=${exp.type}`,
            );
          }
          if (got.pk > 0 !== exp.primary) {
            problems.push(
              `[${table}.${name}] PK DDL=${got.pk > 0} Drizzle=${exp.primary}`,
            );
          }
          // SQLite does not force NOT NULL on a non-INTEGER PRIMARY KEY, so
          // nullability / default checks are meaningful only off the PK.
          if (!exp.primary) {
            if ((got.notnull === 1) !== exp.notNull) {
              problems.push(
                `[${table}.${name}] notNull DDL=${got.notnull === 1} Drizzle=${exp.notNull}`,
              );
            }
            if ((got.dflt_value !== null) !== exp.hasDefault) {
              problems.push(
                `[${table}.${name}] hasDefault DDL=${got.dflt_value !== null} Drizzle=${exp.hasDefault}`,
              );
            }
          }
        }
      }
      expect(problems, problems.join("\n")).toEqual([]);
    } finally {
      db.close();
    }
  });
});

// ── PostgreSQL column parity (gated on a real PG) ───────────────

const DATABASE_URL = process.env.DATABASE_URL;
let pgAvailable = false;
if (DATABASE_URL) {
  try {
    const { default: postgres } = await import("postgres");
    const client = postgres(DATABASE_URL, { connect_timeout: 3 });
    await client`SELECT 1`;
    await client.end();
    pgAvailable = true;
  } catch {
    pgAvailable = false;
  }
}

/** Normalize a Drizzle PG SQL type to its information_schema.data_type. */
function pgInfoType(sqlType: string): string {
  switch (sqlType) {
    case "serial":
      return "integer"; // SERIAL is an integer + sequence default
    default:
      return sqlType;
  }
}

describe.skipIf(!pgAvailable)(
  "DDL codegen ↔ Drizzle parity (PostgreSQL)",
  () => {
    it("real PG generated DDL yields exactly the Drizzle column shape", async () => {
      const { default: postgres } = await import("postgres");
      const { createIsolatedPgUrl } = await import("./pg-test-db.js");
      const url = await createIsolatedPgUrl(
        DATABASE_URL!,
        "covel_test_ddlcodegen",
      );
      const client = postgres(url, { max: 1 });
      try {
        await client.unsafe(PG_DDL);

        const rows = (await client`
        SELECT table_name, column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public'
      `) as unknown as Array<{
          table_name: string;
          column_name: string;
          data_type: string;
          is_nullable: string;
          column_default: string | null;
        }>;

        const actual = new Map<string, Map<string, (typeof rows)[number]>>();
        for (const r of rows) {
          if (!actual.has(r.table_name)) actual.set(r.table_name, new Map());
          actual.get(r.table_name)!.set(r.column_name, r);
        }

        const problems: string[] = [];
        for (const value of Object.values(pgSchema)) {
          if (!is(value, PgTable)) continue;
          const cfg = getPgConfig(value);
          const cols = actual.get(cfg.name);
          if (!cols) {
            problems.push(`table "${cfg.name}" missing from PG`);
            continue;
          }
          for (const c of cfg.columns) {
            const got = cols.get(c.name);
            if (!got) {
              problems.push(`[${cfg.name}] column "${c.name}" missing in PG`);
              continue;
            }
            const expType = pgInfoType(c.getSQLType());
            // jsonb shows as "jsonb"; bytea as "bytea"; text/integer/bigint direct.
            if (got.data_type !== expType) {
              problems.push(
                `[${cfg.name}.${c.name}] type PG=${got.data_type} Drizzle=${expType}`,
              );
            }
            if (!c.primary) {
              if ((got.is_nullable === "NO") !== c.notNull) {
                problems.push(
                  `[${cfg.name}.${c.name}] notNull PG=${got.is_nullable === "NO"} Drizzle=${c.notNull}`,
                );
              }
              const expHasDefault = c.hasDefault && c.default !== undefined;
              if ((got.column_default !== null) !== expHasDefault) {
                problems.push(
                  `[${cfg.name}.${c.name}] hasDefault PG=${got.column_default !== null} Drizzle=${expHasDefault}`,
                );
              }
            }
          }
        }
        expect(problems, problems.join("\n")).toEqual([]);
      } finally {
        await client.end();
      }
    });
  },
);
