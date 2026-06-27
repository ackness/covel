/**
 * Drizzle-schema → CREATE TABLE DDL generator (single source of truth).
 *
 * The store historically defined every table's shape FOUR times: two Drizzle
 * schemas (`sqlite/schema.ts`, `postgres/schema.ts`, consumed by the query
 * builder + types + drizzle-kit) and two hand-written DDL strings
 * (`sqlite/sqlite-schema-ddl.ts`, `postgres/pg-schema-ddl.ts`, executed at boot
 * via `sqlite.exec` / `client.unsafe`). The two pairs drifted historically
 * (PG `trace_events` lost indexes; SQLite index names diverged).
 *
 * This module collapses the column + index definitions to ONE editable source:
 * the Drizzle schema. The boot DDL is now DERIVED from the Drizzle tables at
 * import time, so a column or index can only be declared once (in Drizzle) and
 * the executed DDL can never drift from it. The boot path is unchanged — the
 * consumers still receive a `CREATE TABLE ...` string and `exec`/`unsafe` it.
 *
 * What this generator intentionally does NOT model (Drizzle has no concept of
 * these, so they stay hand-written next to the boot path that needs them):
 *   - triggers (vector_models table-name backfill, both backends);
 *   - idempotent in-place column migrations for already-existing databases
 *     (`ALTER TABLE ... ADD/DROP COLUMN IF [NOT] EXISTS`).
 * Those are operational concerns, not a second copy of the schema columns.
 *
 * The generator is a pure function of the Drizzle schema: identical input
 * yields an identical string every run (determinism is pinned by a test).
 */

import { getTableName, is } from "drizzle-orm";
import {
  SQLiteTable,
  getTableConfig as getSqliteConfig,
} from "drizzle-orm/sqlite-core";
import { PgTable, getTableConfig as getPgConfig } from "drizzle-orm/pg-core";

export type Dialect = "sqlite" | "pg";

interface ColumnSpec {
  readonly name: string;
  readonly sqlType: string;
  readonly notNull: boolean;
  readonly primary: boolean;
  readonly autoIncrement: boolean;
  readonly dataType: string;
  readonly hasDefault: boolean;
  readonly default: unknown;
}

interface IndexSpec {
  readonly name: string;
  readonly unique: boolean;
  readonly columns: readonly string[];
}

interface TableSpec {
  readonly name: string;
  readonly columns: readonly ColumnSpec[];
  readonly indexes: readonly IndexSpec[];
}

/**
 * SQL reserved words that must be quoted when used as an identifier. Kept small
 * and focused on words the schema actually uses (or is likely to). Quoting a
 * non-reserved identifier is harmless, so over-inclusion is safe.
 */
const RESERVED_IDENTIFIERS = new Set<string>([
  "order",
  "values",
  "user",
  "group",
  "select",
  "from",
  "where",
  "table",
  "default",
  "check",
  "column",
  "constraint",
  "primary",
  "foreign",
  "unique",
  "index",
  "limit",
  "offset",
]);

function quoteIdent(name: string): string {
  return RESERVED_IDENTIFIERS.has(name.toLowerCase()) ? `"${name}"` : name;
}

function quoteString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Render a column's `DEFAULT` literal. `json` columns (PG `jsonb`) serialize the
 * JS default and cast to jsonb; SQLite stores JSON as `text` whose default is
 * already a JSON string and is handled by the string branch.
 */
function formatDefault(col: ColumnSpec): string {
  if (col.dataType === "json") {
    return `${quoteString(JSON.stringify(col.default))}::jsonb`;
  }
  if (typeof col.default === "string") return quoteString(col.default);
  if (typeof col.default === "number" || typeof col.default === "boolean") {
    return String(col.default);
  }
  // Fallback: serialize unknown shapes deterministically. No current column hits
  // this branch, but it keeps the generator from emitting `undefined`.
  return quoteString(JSON.stringify(col.default));
}

function renderColumn(col: ColumnSpec, dialect: Dialect): string {
  const parts = [quoteIdent(col.name), col.sqlType.toUpperCase()];
  if (col.primary) {
    parts.push("PRIMARY KEY");
    // SQLite autoincrement only applies to an INTEGER PRIMARY KEY. PG uses the
    // SERIAL type instead, which carries its own sequence default.
    if (dialect === "sqlite" && col.autoIncrement) parts.push("AUTOINCREMENT");
    // A PRIMARY KEY column is implicitly NOT NULL and (for serial/autoincrement)
    // supplies its own default, so we skip both here to match idiomatic DDL.
  } else {
    if (col.notNull) parts.push("NOT NULL");
    if (col.hasDefault && col.default !== undefined) {
      parts.push(`DEFAULT ${formatDefault(col)}`);
    }
  }
  return parts.join(" ");
}

function renderTable(spec: TableSpec, dialect: Dialect): string {
  const cols = spec.columns
    .map((c) => `  ${renderColumn(c, dialect)}`)
    .join(",\n");
  const create = `CREATE TABLE IF NOT EXISTS ${spec.name} (\n${cols}\n);`;
  const indexes = spec.indexes.map((idx) => {
    const kw = idx.unique ? "CREATE UNIQUE INDEX" : "CREATE INDEX";
    return `${kw} IF NOT EXISTS ${idx.name} ON ${spec.name}(${idx.columns.join(", ")});`;
  });
  return [create, ...indexes].join("\n");
}

function toTableSpec(table: unknown, dialect: Dialect): TableSpec | null {
  if (dialect === "sqlite") {
    if (!is(table, SQLiteTable)) return null;
    const cfg = getSqliteConfig(table);
    return {
      name: cfg.name,
      columns: cfg.columns.map((c) => ({
        name: c.name,
        sqlType: c.getSQLType(),
        notNull: c.notNull,
        primary: c.primary,
        autoIncrement: Boolean(
          (c as { autoIncrement?: boolean }).autoIncrement,
        ),
        dataType: c.dataType,
        hasDefault: c.hasDefault,
        default: c.default,
      })),
      indexes: cfg.indexes.map((idx) => ({
        name: idx.config.name,
        unique: Boolean(idx.config.unique),
        columns: idx.config.columns.map(
          (col) => (col as { name?: string }).name ?? String(col),
        ),
      })),
    };
  }
  if (!is(table, PgTable)) return null;
  const cfg = getPgConfig(table);
  return {
    name: cfg.name,
    columns: cfg.columns.map((c) => ({
      name: c.name,
      sqlType: c.getSQLType(),
      notNull: c.notNull,
      primary: c.primary,
      autoIncrement: false,
      dataType: c.dataType,
      hasDefault: c.hasDefault,
      default: c.default,
    })),
    indexes: cfg.indexes.map((idx) => ({
      name: idx.config.name ?? "",
      unique: Boolean(idx.config.unique),
      columns: idx.config.columns.map(
        (col) => (col as { name?: string }).name ?? String(col),
      ),
    })),
  };
}

/**
 * Generate `CREATE TABLE IF NOT EXISTS` + index DDL for every Drizzle table in
 * `tables`, in the order given (declaration order is stable and deterministic).
 * Non-table values are ignored, so `Object.values(schema)` can be passed
 * directly.
 */
export function buildCreateTablesSql(
  tables: readonly unknown[],
  dialect: Dialect,
): string {
  const blocks: string[] = [];
  for (const table of tables) {
    const spec = toTableSpec(table, dialect);
    if (spec) blocks.push(renderTable(spec, dialect));
  }
  return blocks.join("\n\n");
}

/** Resolve the SQL table name for a Drizzle table (either dialect). */
export function tableNameOf(table: unknown): string {
  return getTableName(table as never);
}
