/**
 * Backend-agnostic session CRUD (create / get / update / list), shared by the
 * PostgreSQL and SQLite backends.
 *
 * Previously `postgres/pg-session-records.ts` and `sqlite/sqlite-sessions.ts`
 * were mirrors differing only in the sync/async terminal, the JSON
 * serialization, and — divergently — their optional-field coercion: SQLite
 * inlined `JSON.stringify(... ?? [])` / `JSON.stringify(... ?? {})`, PG passed
 * values through with `?? {}`. The serialization now flows through the
 * {@link InsertValueBuilders.sessionInsert} / `sessionUpdate` value builders
 * (the {@link JsonWriter} gateway), so an absent `runtimeModelOverrides` map is
 * stored as SQL NULL on every backend instead of an empty-object literal — no
 * inline `JSON.stringify`, no inconsistent `?? []` / `?? {}` coercion.
 *
 * `deleteSession` stays per-backend: its cascade differs (table-registry-driven
 * SQLite cascade vs PG transactional cascade) and is out of scope here.
 */

import { eq } from "drizzle-orm";
import type { Column, Table } from "drizzle-orm";

import type { InsertValueBuilders } from "./insert-values.js";
import type { JsonReader } from "./mappers.js";
import { toSessionRecord } from "./mappers.js";
import type { SessionRow } from "./mappers/session-mappers.js";
import type { SqlRunner } from "./sql-runner.js";
import type { DataStore, SessionRecord } from "../types.js";
import { mergeSessionPatch } from "../types.js";
import {
  isUniqueConstraintError,
  SessionAlreadyExistsError,
} from "../errors.js";

type SessionsTable = Table & { id: Column };

export interface SqlSessionTables {
  readonly sessions: SessionsTable;
}

export interface SqlSessionDeps {
  readonly runner: SqlRunner;
  readonly tables: SqlSessionTables;
  readonly json: JsonReader;
  readonly values: Pick<InsertValueBuilders, "sessionInsert" | "sessionUpdate">;
}

/**
 * The session CRUD surface shared across both SQL backends. `deleteSession` is
 * deliberately excluded — each backend supplies its own cascade.
 */
export type SqlSessionRecords = Pick<
  DataStore,
  "createSession" | "getSession" | "updateSession" | "listSessions"
>;

export function createSqlSessionRecords(
  deps: SqlSessionDeps,
): SqlSessionRecords {
  const { runner, tables, json, values } = deps;
  const { sessions } = tables;

  return {
    async createSession(session: SessionRecord): Promise<void> {
      try {
        await runner.insert(sessions, values.sessionInsert(session));
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new SessionAlreadyExistsError(session.id);
        }
        throw error;
      }
    },

    async getSession(id: string): Promise<SessionRecord | null> {
      const row = await runner.selectFirst<SessionRow>(sessions, {
        where: eq(sessions.id, id),
      });
      return row ? toSessionRecord(row, json) : null;
    },

    async updateSession(
      id: string,
      patch: Parameters<DataStore["updateSession"]>[1],
    ): Promise<void> {
      const existingRow = await runner.selectFirst<SessionRow>(sessions, {
        where: eq(sessions.id, id),
      });
      if (!existingRow) return;
      const mergedSession = mergeSessionPatch(
        toSessionRecord(existingRow, json),
        patch,
      );
      const updateValues = values.sessionUpdate(patch, mergedSession);
      if (Object.keys(updateValues).length > 0) {
        await runner.update(sessions, updateValues, eq(sessions.id, id));
      }
    },

    async listSessions(): Promise<SessionRecord[]> {
      const rows = await runner.select<SessionRow>(sessions);
      return rows.map((row) => toSessionRecord(row, json));
    },
  };
}
