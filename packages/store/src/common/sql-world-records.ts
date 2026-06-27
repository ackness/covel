/**
 * Backend-agnostic world record queries, shared by the PostgreSQL and SQLite
 * backends.
 *
 * The query logic (which table, where clauses, conflict targets) is identical
 * across both SQL backends — only the sync/async terminal and the JSON
 * serialization differ. Those differences are injected: the {@link SqlRunner}
 * abstracts the terminal, the {@link JsonReader} the read gateway, and the
 * value builders the write gateway. Each backend supplies thin adapters and
 * delegates here, so this is the single source of truth for world CRUD.
 */

import { eq } from "drizzle-orm";
import type { Column, Table } from "drizzle-orm";

import type { JsonReader } from "./mappers.js";
import { toWorldRecord } from "./mappers.js";
import type { WorldRow } from "./mappers/world-mappers.js";
import type { InsertValueBuilders } from "./insert-values.js";
import type { SqlRunner } from "./sql-runner.js";
import type { DataStore, WorldRecord } from "../types.js";

/** Structural handle to the `worlds` table (only the columns this module uses). */
export type WorldsTable = Table & { id: Column };

export interface SqlWorldRecordsDeps {
  readonly runner: SqlRunner;
  readonly worlds: WorldsTable;
  readonly json: JsonReader;
  readonly values: Pick<InsertValueBuilders, "worldInsert" | "worldUpdate">;
}

export type SqlWorldRecords = Pick<
  DataStore,
  "listWorlds" | "getWorld" | "upsertWorld" | "deleteWorld"
>;

export function createSqlWorldRecords(
  deps: SqlWorldRecordsDeps,
): SqlWorldRecords {
  const { runner, worlds, json, values } = deps;
  return {
    async listWorlds(): Promise<WorldRecord[]> {
      const rows = await runner.select<WorldRow>(worlds);
      return rows.map((row) => toWorldRecord(row, json));
    },

    async getWorld(id: string): Promise<WorldRecord | null> {
      const row = await runner.selectFirst<WorldRow>(worlds, {
        where: eq(worlds.id, id),
      });
      return row ? toWorldRecord(row, json) : null;
    },

    async upsertWorld(record: WorldRecord): Promise<void> {
      await runner.insert(worlds, values.worldInsert(record), {
        target: worlds.id,
        set: values.worldUpdate(record),
      });
    },

    async deleteWorld(id: string): Promise<void> {
      await runner.delete(worlds, eq(worlds.id, id));
    },
  };
}
