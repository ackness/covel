/**
 * SQLite {@link SqlRunner} adapter (better-sqlite3 + Drizzle).
 *
 * The ONLY place in the SQLite backend that bridges the dialect-agnostic shared
 * query layer to the concrete `better-sqlite3` driver. better-sqlite3 is fully
 * synchronous, so each terminal (`.all()/.get()/.run()`) is wrapped in
 * `Promise.resolve(...)` to satisfy the async {@link SqlRunner} contract — a
 * zero-cost wrap, identical in behaviour to the legacy inline calls. The loose
 * `Table` handle is cast up to `SQLiteTable` for the driver; these casts are the
 * dialect-bridging gateway (analogous to `sqliteJsonReader`/`sqliteJsonWriter`)
 * and are sound — the shared modules only ever pass real SQLite schema tables.
 *
 * Batch upserts use a synchronous `db.transaction(...)` body (better-sqlite3
 * cannot await inside a transaction), preserving the legacy atomic batch loops.
 */

import type { SQL, Table } from "drizzle-orm";
import type { IndexColumn, SQLiteTable } from "drizzle-orm/sqlite-core";

import type {
  ConflictClause,
  SelectOpts,
  SqlRunner,
  UpsertRow,
} from "../common/sql-runner.js";
import type { SqliteDb } from "./sqlite-types.js";

/** SQLite-cast a loose conflict clause to the driver's onConflict config. */
function sqliteConflictConfig(conflict: ConflictClause): {
  target: IndexColumn | IndexColumn[];
  set: Record<string, unknown>;
} {
  return {
    target: conflict.target as IndexColumn | IndexColumn[],
    set: conflict.set,
  };
}

export function createSqliteSqlRunner(db: SqliteDb): SqlRunner {
  return {
    select<Row>(table: Table, opts?: SelectOpts): Promise<Row[]> {
      let query = db
        .select()
        .from(table as SQLiteTable)
        .$dynamic();
      if (opts?.where) query = query.where(opts.where);
      if (opts?.orderBy && opts.orderBy.length > 0) {
        query = query.orderBy(...opts.orderBy);
      }
      if (opts?.limit !== undefined) query = query.limit(opts.limit);
      if (opts?.offset) query = query.offset(opts.offset);
      return Promise.resolve(query.all() as unknown as Row[]);
    },

    selectFirst<Row>(
      table: Table,
      opts?: SelectOpts,
    ): Promise<Row | undefined> {
      let query = db
        .select()
        .from(table as SQLiteTable)
        .$dynamic();
      if (opts?.where) query = query.where(opts.where);
      if (opts?.orderBy && opts.orderBy.length > 0) {
        query = query.orderBy(...opts.orderBy);
      }
      query = query.limit(1);
      const row = query.get();
      return Promise.resolve((row ?? undefined) as unknown as Row | undefined);
    },

    insert(
      table: Table,
      values: Record<string, unknown>,
      conflict?: ConflictClause,
    ): Promise<void> {
      const stmt = db.insert(table as SQLiteTable).values(values);
      if (conflict) {
        stmt.onConflictDoUpdate(sqliteConflictConfig(conflict)).run();
      } else {
        stmt.run();
      }
      return Promise.resolve();
    },

    insertManyAtomic(table: Table, rows: readonly UpsertRow[]): Promise<void> {
      if (rows.length === 0) return Promise.resolve();
      // better-sqlite3 transactions are synchronous and run on the single
      // connection; the callback executes immediately (no trailing call).
      db.transaction((tx) => {
        for (const row of rows) {
          const stmt = tx.insert(table as SQLiteTable).values(row.values);
          if (row.conflict) {
            stmt.onConflictDoUpdate(sqliteConflictConfig(row.conflict)).run();
          } else {
            stmt.run();
          }
        }
      });
      return Promise.resolve();
    },

    update(
      table: Table,
      set: Record<string, unknown>,
      where?: SQL,
    ): Promise<void> {
      const stmt = db.update(table as SQLiteTable).set(set);
      if (where) {
        stmt.where(where).run();
      } else {
        stmt.run();
      }
      return Promise.resolve();
    },

    delete(table: Table, where?: SQL): Promise<void> {
      const stmt = db.delete(table as SQLiteTable);
      if (where) {
        stmt.where(where).run();
      } else {
        stmt.run();
      }
      return Promise.resolve();
    },
  };
}
