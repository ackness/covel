/**
 * PostgreSQL {@link SqlRunner} adapter (postgres.js + Drizzle).
 *
 * The ONLY place in the PG backend that bridges the dialect-agnostic shared
 * query layer to the concrete `postgres.js` driver: it awaits each query and
 * casts the loose `Table` handle up to `PgTable` for the driver. These casts are
 * the dialect-bridging gateway (analogous to `pgJsonReader`/`pgJsonWriter`) and
 * are sound — the shared modules only ever pass real PG schema tables. The
 * structural `Row` types come from `common/mappers/*` and match each table's
 * `$inferSelect` shape, so the row assertions never lose real information.
 */

import type { SQL, Table } from "drizzle-orm";
import type { IndexColumn, PgTable } from "drizzle-orm/pg-core";

import type {
  ConflictClause,
  SelectOpts,
  SqlRunner,
  UpsertRow,
} from "../common/sql-runner.js";
import type { PgDb } from "./pg-db.js";

/** PG-cast a loose conflict clause to the driver's `onConflictDoUpdate` config. */
function pgConflictConfig(conflict: ConflictClause): {
  target: IndexColumn | IndexColumn[];
  set: Record<string, unknown>;
} {
  return {
    target: conflict.target as IndexColumn | IndexColumn[],
    set: conflict.set,
  };
}

export function createPgSqlRunner(getDb: () => PgDb): SqlRunner {
  return {
    async select<Row>(table: Table, opts?: SelectOpts): Promise<Row[]> {
      let query = getDb()
        .select()
        .from(table as PgTable)
        .$dynamic();
      if (opts?.where) query = query.where(opts.where);
      if (opts?.orderBy && opts.orderBy.length > 0) {
        query = query.orderBy(...opts.orderBy);
      }
      if (opts?.limit !== undefined) query = query.limit(opts.limit);
      if (opts?.offset) query = query.offset(opts.offset);
      const rows = await query;
      return rows as unknown as Row[];
    },

    async selectFirst<Row>(
      table: Table,
      opts?: SelectOpts,
    ): Promise<Row | undefined> {
      const rows = await this.select<Row>(table, { ...opts, limit: 1 });
      return rows[0];
    },

    async insert(
      table: Table,
      values: Record<string, unknown>,
      conflict?: ConflictClause,
    ): Promise<void> {
      const stmt = getDb()
        .insert(table as PgTable)
        .values(values);
      if (conflict) {
        await stmt.onConflictDoUpdate(pgConflictConfig(conflict));
      } else {
        await stmt;
      }
    },

    async insertManyAtomic(
      table: Table,
      rows: readonly UpsertRow[],
    ): Promise<void> {
      if (rows.length === 0) return;
      await getDb().transaction(async (tx) => {
        for (const row of rows) {
          const stmt = tx.insert(table as PgTable).values(row.values);
          if (row.conflict) {
            await stmt.onConflictDoUpdate(pgConflictConfig(row.conflict));
          } else {
            await stmt;
          }
        }
      });
    },

    async update(
      table: Table,
      set: Record<string, unknown>,
      where?: SQL,
    ): Promise<void> {
      const stmt = getDb()
        .update(table as PgTable)
        .set(set);
      await (where ? stmt.where(where) : stmt);
    },

    async delete(table: Table, where?: SQL): Promise<void> {
      const stmt = getDb().delete(table as PgTable);
      await (where ? stmt.where(where) : stmt);
    },
  };
}
