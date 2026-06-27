import { makeInsertValues } from "../common/insert-values.js";
import { sqliteJsonReader } from "../common/json-readers.js";
import { sqliteJsonWriter } from "../common/json-writers.js";
import { createSqlSessionRecords } from "../common/sql-session-records.js";
import type { DataStore } from "../types.js";
import * as schema from "./schema.js";
import { deleteSqliteSessionCascade } from "./sqlite-session-cascade.js";
import { createSqliteSqlRunner } from "./sqlite-sql-runner.js";
import type { SqliteConnection, SqliteDb } from "./sqlite-types.js";

export type SqliteSessions = Pick<
  DataStore,
  | "createSession"
  | "getSession"
  | "updateSession"
  | "listSessions"
  | "deleteSession"
>;

export function createSqliteSessions(
  sqlite: SqliteConnection,
  db: SqliteDb,
): SqliteSessions {
  return {
    ...createSqlSessionRecords({
      runner: createSqliteSqlRunner(db),
      json: sqliteJsonReader,
      values: makeInsertValues(sqliteJsonWriter),
      tables: { sessions: schema.sessions },
    }),

    async deleteSession(id: string): Promise<void> {
      deleteSqliteSessionCascade(sqlite, id);
    },
  };
}
