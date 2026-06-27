import { makeInsertValues } from "../common/insert-values.js";
import { pgJsonReader } from "../common/json-readers.js";
import { pgJsonWriter } from "../common/json-writers.js";
import { createSqlSessionRecords } from "../common/sql-session-records.js";
import type { DataStore } from "../types.js";
import type { PgDb } from "./pg-db.js";
import { createPgSqlRunner } from "./pg-sql-runner.js";
import { deletePgSessionCascade } from "./pg-session-cascade.js";
import * as schema from "./schema.js";

export type PgSessionRecords = Pick<
  DataStore,
  | "createSession"
  | "getSession"
  | "updateSession"
  | "listSessions"
  | "deleteSession"
>;

export function createPgSessionRecords(getDb: () => PgDb): PgSessionRecords {
  return {
    ...createSqlSessionRecords({
      runner: createPgSqlRunner(getDb),
      json: pgJsonReader,
      values: makeInsertValues(pgJsonWriter),
      tables: { sessions: schema.sessions },
    }),

    async deleteSession(id: string): Promise<void> {
      await getDb().transaction(async (tx) => {
        await deletePgSessionCascade(tx, id);
      });
    },
  };
}
