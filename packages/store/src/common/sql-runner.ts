/**
 * Dialect-agnostic async execution facade over a Drizzle query builder.
 *
 * Both SQL backends (PostgreSQL + postgres.js, SQLite + better-sqlite3) build
 * structurally identical Drizzle queries for the record CRUD modules. The ONLY
 * differences are:
 *
 *  1. better-sqlite3 terminates queries synchronously (`.all()/.get()/.run()`)
 *     while postgres.js returns an awaitable query; and
 *  2. the concrete table/driver types differ (`PgTable` vs `SQLiteTable`).
 *
 * This {@link SqlRunner} hides both behind a uniform `Promise`-returning
 * surface so the per-table record modules under `common/sql-*-records.ts` can be
 * written ONCE and shared by both backends. Each backend supplies a thin runner
 * adapter (`postgres/pg-sql-runner.ts` / `sqlite/sqlite-sql-runner.ts`) — the
 * single place the sync/async and dialect-type differences live. This mirrors
 * the existing JsonReader / JsonWriter serialization gateways that already
 * de-duplicate the read and value-building paths.
 *
 * The runner is intentionally *not* generic over the concrete Drizzle table
 * type: doing so would force every shared module to re-derive `PgTable` vs
 * `SQLiteTable` unions. Instead the shared modules type their table handles via
 * small structural `Table & { col: Column }` interfaces (column access stays
 * type-safe; the operators `eq`/`and`/`asc`/`desc` accept the base `Column`),
 * and the runner returns rows under a caller-supplied structural `Row` type.
 * The narrow, dialect-bridging casts live exclusively inside the two adapters.
 */

import type { Column, SQL, Table } from "drizzle-orm";

/** Conflict target for an upsert — one or more columns of the target table. */
export type ConflictTarget = Column | Column[];

/** `onConflictDoUpdate` clause: which columns collide and what to set. */
export interface ConflictClause {
  readonly target: ConflictTarget;
  /**
   * Columns to overwrite on conflict. Built by the shared value builders
   * (`makeInsertValues`), which already return a backend-agnostic
   * `Record<string, unknown>` payload.
   */
  readonly set: Record<string, unknown>;
}

/** Optional refinements for a SELECT. */
export interface SelectOpts {
  readonly where?: SQL;
  readonly orderBy?: readonly SQL[];
  readonly limit?: number;
  readonly offset?: number;
}

/** One row of an atomic batch upsert: insert payload + optional conflict. */
export interface UpsertRow {
  readonly values: Record<string, unknown>;
  readonly conflict?: ConflictClause;
}

/**
 * The uniform async query surface shared by both SQL backends. Implementations
 * are the only modules allowed to know the concrete dialect/driver types.
 */
export interface SqlRunner {
  /** SELECT rows from `table`, optionally filtered/ordered/paginated. */
  select<Row>(table: Table, opts?: SelectOpts): Promise<Row[]>;

  /** SELECT the first matching row (applies `limit 1`), or `undefined`. */
  selectFirst<Row>(table: Table, opts?: SelectOpts): Promise<Row | undefined>;

  /** INSERT a single row, optionally as an upsert (`onConflictDoUpdate`). */
  insert(
    table: Table,
    values: Record<string, unknown>,
    conflict?: ConflictClause,
  ): Promise<void>;

  /**
   * Upsert many rows atomically inside one transaction. A no-op on an empty
   * batch. Each row carries its own `set`, so per-record update payloads are
   * preserved (matching the legacy per-backend batch loops).
   */
  insertManyAtomic(table: Table, rows: readonly UpsertRow[]): Promise<void>;

  /** UPDATE rows matching `where` (all rows when omitted) with `set`. */
  update(
    table: Table,
    set: Record<string, unknown>,
    where?: SQL,
  ): Promise<void>;

  /**
   * Conditional UPDATE used for atomic compare-and-swap (e.g. claim a
   * suspension): applies `set` to rows matching `where` and returns the number
   * of rows actually affected. This is the one place the two backends report a
   * mutation count through different driver surfaces — PG via `RETURNING`,
   * better-sqlite3 via the `changes` field of the run result — and the adapters
   * normalise both to a plain count. The single serialized write per dialect
   * keeps the swap atomic, so two concurrent claims cannot both observe `1`.
   */
  updateReturningCount(
    table: Table,
    set: Record<string, unknown>,
    where?: SQL,
  ): Promise<number>;

  /** DELETE rows matching `where` (all rows when omitted). */
  delete(table: Table, where?: SQL): Promise<void>;
}
