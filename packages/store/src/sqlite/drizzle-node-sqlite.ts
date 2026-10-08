/**
 * Drizzle's synchronous SQLite session over `node:sqlite`.
 *
 * drizzle-orm 0.45 ships no `node:sqlite` driver, and its better-sqlite3
 * driver imports that package. This is the better-sqlite3 session with the
 * statement calls swapped: `node:sqlite` returns array rows through
 * `setReturnArrays` instead of `raw()`, and transactions run through
 * {@link runSqliteTransaction}, which nests as a savepoint inside an open one.
 */

import type { SQLInputValue, StatementSync } from "node:sqlite";
import {
  createTableRelationsHelpers,
  entityKind,
  extractTablesRelationalConfig,
  fillPlaceholders,
  NoopLogger,
  type ExtractTablesWithRelations,
  type Logger,
  type Query,
  type RelationalSchemaConfig,
  type TablesRelationalConfig,
} from "drizzle-orm";
import {
  BaseSQLiteDatabase,
  SQLitePreparedQuery,
  SQLiteSession,
  SQLiteSyncDialect,
  SQLiteTransaction,
  type PreparedQueryConfig,
  type SelectedFieldsOrdered,
  type SQLiteExecuteMethod,
  type SQLiteTransactionConfig,
} from "drizzle-orm/sqlite-core";
import * as drizzleUtils from "drizzle-orm/utils";

import { runSqliteTransaction, type SqliteConnection } from "./node-sqlite.js";

/** What a write reports. Integers read as numbers (`readBigInts` is off). */
export interface SqliteRunResult {
  changes: number;
  lastInsertRowid: number;
}

type QueryConfig = Omit<PreparedQueryConfig, "statement" | "run">;

type RowMapper = (rows: unknown[][]) => unknown;

type JoinsNotNullable = Record<string, boolean> | undefined;

// Exported at runtime but marked @internal in drizzle's types. It decodes an
// array row into the selected shape exactly as drizzle's own drivers do.
const { mapResultRow } = drizzleUtils as unknown as {
  mapResultRow: (
    columns: SelectedFieldsOrdered,
    row: unknown[],
    joinsNotNullableMap: JoinsNotNullable,
  ) => unknown;
};

function bind(params: unknown[]): SQLInputValue[] {
  return params as SQLInputValue[];
}

class NodeSqlitePreparedQuery<
  T extends QueryConfig = QueryConfig,
> extends SQLitePreparedQuery<{
  type: "sync";
  run: SqliteRunResult;
  all: T["all"];
  get: T["get"];
  values: T["values"];
  execute: T["execute"];
}> {
  static override readonly [entityKind]: string = "NodeSqlitePreparedQuery";

  constructor(
    private readonly stmt: StatementSync,
    query: Query,
    private readonly logger: Logger,
    private readonly fields: SelectedFieldsOrdered | undefined,
    executeMethod: SQLiteExecuteMethod,
    private readonly responseInArrayMode: boolean,
    private readonly customResultMapper?: RowMapper,
  ) {
    super("sync", executeMethod, query);
  }

  /** `joinsNotNullableMap`, set by the select builder; internal to drizzle. */
  private get nullableJoins(): JoinsNotNullable {
    return (this as unknown as { joinsNotNullableMap?: JoinsNotNullable })
      .joinsNotNullableMap;
  }

  private params(placeholderValues?: Record<string, unknown>): unknown[] {
    const params = fillPlaceholders(this.query.params, placeholderValues ?? {});
    this.logger.logQuery(this.query.sql, params);
    return params;
  }

  /** Run with array rows, the shape `mapResultRow` reads. */
  private arrays<R>(read: (stmt: StatementSync) => R): R {
    this.stmt.setReturnArrays(true);
    try {
      return read(this.stmt);
    } finally {
      this.stmt.setReturnArrays(false);
    }
  }

  run(placeholderValues?: Record<string, unknown>): SqliteRunResult {
    return this.stmt.run(
      ...bind(this.params(placeholderValues)),
    ) as SqliteRunResult;
  }

  all(placeholderValues?: Record<string, unknown>): T["all"] {
    const { fields, customResultMapper } = this;
    if (!fields && !customResultMapper) {
      return this.stmt.all(...bind(this.params(placeholderValues)));
    }
    const rows = this.values(placeholderValues) as unknown[][];
    if (customResultMapper) return customResultMapper(rows) as T["all"];
    return rows.map((row) => mapResultRow(fields!, row, this.nullableJoins));
  }

  get(placeholderValues?: Record<string, unknown>): T["get"] {
    const params = bind(this.params(placeholderValues));
    const { fields, customResultMapper } = this;
    if (!fields && !customResultMapper) return this.stmt.get(...params);
    const row = this.arrays((stmt) => stmt.get(...params)) as
      unknown[] | undefined;
    if (!row) return undefined;
    if (customResultMapper) return customResultMapper([row]) as T["get"];
    return mapResultRow(fields!, row, this.nullableJoins);
  }

  values(placeholderValues?: Record<string, unknown>): T["values"] {
    const params = bind(this.params(placeholderValues));
    return this.arrays((stmt) => stmt.all(...params));
  }

  /** @internal Read by drizzle's relational query builder. */
  isResponseInArrayMode(): boolean {
    return this.responseInArrayMode;
  }
}

type RelationalSchema<TSchema extends TablesRelationalConfig> =
  RelationalSchemaConfig<TSchema>;

class NodeSqliteSession<
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
> extends SQLiteSession<"sync", SqliteRunResult, TFullSchema, TSchema> {
  static override readonly [entityKind]: string = "NodeSqliteSession";

  constructor(
    readonly client: SqliteConnection,
    readonly syncDialect: SQLiteSyncDialect,
    readonly relationalSchema: RelationalSchema<TSchema> | undefined,
    private readonly logger: Logger,
  ) {
    super(syncDialect);
  }

  prepareQuery<T extends QueryConfig>(
    query: Query,
    fields: SelectedFieldsOrdered | undefined,
    executeMethod: SQLiteExecuteMethod,
    isResponseInArrayMode: boolean,
    customResultMapper?: RowMapper,
  ): NodeSqlitePreparedQuery<T> {
    return new NodeSqlitePreparedQuery<T>(
      this.client.prepare(query.sql),
      query,
      this.logger,
      fields,
      executeMethod,
      isResponseInArrayMode,
      customResultMapper,
    );
  }

  transaction<T>(
    transaction: (tx: NodeSqliteTransaction<TFullSchema, TSchema>) => T,
    config: SQLiteTransactionConfig = {},
  ): T {
    const tx = new NodeSqliteTransaction(this, 0);
    return runSqliteTransaction(
      this.client,
      () => transaction(tx),
      config.behavior,
    );
  }
}

class NodeSqliteTransaction<
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
> extends SQLiteTransaction<"sync", SqliteRunResult, TFullSchema, TSchema> {
  static override readonly [entityKind]: string = "NodeSqliteTransaction";

  constructor(
    private readonly owner: NodeSqliteSession<TFullSchema, TSchema>,
    nestedIndex: number,
  ) {
    super(
      "sync",
      owner.syncDialect,
      owner,
      owner.relationalSchema,
      nestedIndex,
    );
  }

  override transaction<T>(
    transaction: (tx: NodeSqliteTransaction<TFullSchema, TSchema>) => T,
  ): T {
    // Already inside a transaction, so this runs as a savepoint.
    const tx = new NodeSqliteTransaction(this.owner, this.nestedIndex + 1);
    return runSqliteTransaction(this.owner.client, () => transaction(tx));
  }
}

export class NodeSqliteDatabase<
  TSchema extends Record<string, unknown>,
> extends BaseSQLiteDatabase<"sync", SqliteRunResult, TSchema> {
  static override readonly [entityKind]: string = "NodeSqliteDatabase";
}

/** Wrap a connection in a Drizzle database with relational queries for `schema`. */
export function drizzleNodeSqlite<TSchema extends Record<string, unknown>>(
  client: SqliteConnection,
  schema: TSchema,
): NodeSqliteDatabase<TSchema> {
  const dialect = new SQLiteSyncDialect();
  const tables = extractTablesRelationalConfig(
    schema,
    createTableRelationsHelpers,
  );
  const relational = {
    fullSchema: schema,
    schema: tables.tables as ExtractTablesWithRelations<TSchema>,
    tableNamesMap: tables.tableNamesMap,
  };
  const session = new NodeSqliteSession<
    TSchema,
    ExtractTablesWithRelations<TSchema>
  >(client, dialect, relational, new NoopLogger());
  return new NodeSqliteDatabase<TSchema>("sync", dialect, session, relational);
}
