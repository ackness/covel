import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";
import { makeInsertValues } from "../src/common/insert-values.js";
import { pgJsonReader } from "../src/common/json-readers.js";
import { pgJsonWriter } from "../src/common/json-writers.js";
import { createSqlDataCrud } from "../src/common/sql-data-crud.js";
import type { SelectOpts, SqlRunner } from "../src/common/sql-runner.js";
import * as pgSchema from "../src/postgres/schema.js";
import { createPgVectorCapability } from "../src/postgres/pg-vector.js";

describe("PostgreSQL query parity checks (offline SQL verification)", () => {
  it("queryPluginData valueFilter checks jsonb_typeof = 'string' with explicit text key cast on PG", async () => {
    const capturedWheres: Array<SQL | undefined> = [];
    const runner = {
      select: async (_table: unknown, opts?: SelectOpts) => {
        capturedWheres.push(opts?.where);
        return [];
      },
      byteOrder: (col: unknown) => col as unknown as SQL,
    } as unknown as SqlRunner;

    const crud = createSqlDataCrud({
      runner,
      tables: {
        pluginData: pgSchema.pluginData,
        worldDataImportLedger: pgSchema.worldDataImportLedger,
        lorebookEntries: pgSchema.lorebookEntries,
        recordChanges: pgSchema.recordChanges,
      },
      json: pgJsonReader,
      values: makeInsertValues(pgJsonWriter),
    });

    await crud.queryPluginData({
      namespace: "_vf_parity",
      valueFilter: { field: "$status", values: ["42", "ok"] },
    });

    expect(capturedWheres).toHaveLength(1);
    const dialect = new PgDialect();
    const compiled = dialect.sqlToQuery(capturedWheres[0]!);
    expect(compiled.sql).toContain("jsonb_typeof(");
    expect(compiled.sql).toContain("= 'string'");
    expect(compiled.sql).toMatch(/-> CAST\(\$\d+ AS text\)/);
    expect(compiled.sql).toMatch(/->> CAST\(\$\d+ AS text\) in \(/);
    expect(compiled.params).toContain("$status");
    expect(compiled.params).toContain("42");
    expect(compiled.params).toContain("ok");
  });

  it("PgVector deleteVectors rejects mismatched expectedSessionCreatedAt even when session has no locked model or is missing", async () => {
    for (const sessionRows of [
      [{ created_at: "2026-06-01T00:00:00.000Z", embedding_model_id: null }],
      [],
    ]) {
      const makeRunner = () => (strings: TemplateStringsArray) => {
        const query = strings.join("?").replace(/\s+/g, " ").trim();
        if (query.includes("FROM sessions")) {
          return Promise.resolve(sessionRows);
        }
        return Promise.resolve([]);
      };
      const tx = Object.assign(makeRunner(), {
        unsafe: () => Promise.resolve([]),
      });
      const sql = Object.assign(makeRunner(), {
        begin: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
      }) as unknown as Sql;

      const vector = createPgVectorCapability(sql);
      await expect(
        vector.deleteVectors({
          sessionId: "unlocked-session",
          pluginId: "owner",
          expectedSessionCreatedAt: "stale-incarnation",
        }),
      ).rejects.toThrow("incarnation changed");
    }
  });
});
