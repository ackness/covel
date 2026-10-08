import { describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { createTables } from "../src/sqlite/sqlite-store-mappers.js";
import { createSqliteVectorCapability } from "../src/sqlite/sqlite-vector.js";
import { createPgVectorCapability } from "../src/postgres/pg-vector.js";
import { deletePgSessionCascade } from "../src/postgres/pg-session-cascade.js";
import { openSqliteConnection } from "../src/sqlite/node-sqlite.js";

const identity = {
  provider: "test",
  modelName: "embed",
  modelId: "test/embed",
  dim: 2,
};

describe("vector model initialization", () => {
  it("rolls back SQLite registry and DDL together and can retry after outer rollback", async () => {
    const db = openSqliteConnection(":memory:");
    createTables(db);
    const vectors = createSqliteVectorCapability(db)!;
    expect(vectors).not.toBeNull();
    const exec = db.exec.bind(db);
    const spy = vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (sql.includes("CREATE VIRTUAL TABLE"))
        throw new Error("synthetic DDL failure");
      return exec(sql);
    });
    try {
      await expect(vectors.ensureVectorModel(identity)).rejects.toThrow(
        "synthetic DDL failure",
      );
      expect(await vectors.listVectorModels()).toEqual([]);
      spy.mockRestore();
      db.exec("BEGIN");
      const first = await vectors.ensureVectorModel(identity);
      db.exec("ROLLBACK");
      expect(await vectors.listVectorModels()).toEqual([]);
      const second = await vectors.ensureVectorModel(identity);
      expect(second).toEqual(first);
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE name = ?")
          .get(second.tableName),
      ).toBeDefined();
      expect(await vectors.listVectorModels()).toHaveLength(1);
    } finally {
      spy.mockRestore();
      db.close();
    }
  });

  for (const failure of ["extension", "table", "commit"] as const) {
    it(`does not publish PostgreSQL registry/cache on ${failure} failure`, async () => {
      const row = {
        id: 1,
        model_id: identity.modelId,
        provider: identity.provider,
        model_name: identity.modelName,
        dim: 2,
        table_name: "vec_mem_m1",
        created_at: "0",
        last_used_at: null,
      };
      let rows: (typeof row)[] = [];
      let physical = false;
      let fail = true;
      let active = false;
      let queue = Promise.resolve();
      const query = async (parts: TemplateStringsArray) => {
        const sql = parts.join("?").trim();
        if (sql.includes("pg_advisory_xact_lock")) return [];
        if (sql.startsWith("INSERT INTO vector_models")) {
          expect(active).toBe(true);
          if (!rows.length) rows.push(row);
          return [];
        }
        if (sql.includes("SELECT embedding_model_id"))
          return [{ embedding_model_id: 1 }];
        if (sql.startsWith("SELECT id, model_id")) return rows;
        throw new Error(`Unexpected SQL: ${sql}`);
      };
      const client = Object.assign(query, {
        unsafe: async (sql: string) => {
          expect(active).toBe(true);
          if (
            fail &&
            failure === "extension" &&
            sql.includes("CREATE EXTENSION")
          )
            throw new Error("synthetic extension failure");
          if (sql.includes("CREATE TABLE")) {
            if (fail && failure === "table")
              throw new Error("synthetic table failure");
            physical = true;
          }
          return [];
        },
        begin: (task: (tx: unknown) => Promise<unknown>) => {
          const result = queue.then(async () => {
            const oldRows = [...rows];
            const oldPhysical = physical;
            active = true;
            try {
              const result = await task(client);
              if (fail && failure === "commit")
                throw new Error("synthetic commit failure");
              return result;
            } catch (error) {
              rows = oldRows;
              physical = oldPhysical;
              throw error;
            } finally {
              active = false;
            }
          });
          queue = result.then(
            () => {},
            () => {},
          );
          return result;
        },
      });
      const vectors = createPgVectorCapability(client as unknown as Sql);
      await expect(vectors.ensureVectorModel(identity)).rejects.toThrow(
        `synthetic ${failure} failure`,
      );
      expect(rows).toEqual([]);
      expect(physical).toBe(false);
      // An invalid reference must not resolve through a prematurely published cache.
      await expect(
        vectors.resolveSessionVectorTarget("missing-model"),
      ).rejects.toThrow("unknown vector_models");
      const deletes: string[] = [];
      const dialect = new PgDialect();
      const tx = {
        execute: async (sql: SQL) => {
          const query = dialect.sqlToQuery(sql).sql;
          deletes.push(query);
          if (query.includes('DELETE FROM "vec_mem_m1"') && !physical)
            throw new Error("missing physical table");
        },
        select: () => ({
          from: async () =>
            rows.map((r) => ({ id: r.id, tableName: r.table_name })),
        }),
      };
      await deletePgSessionCascade(
        tx as unknown as Parameters<typeof deletePgSessionCascade>[0],
        "unrelated",
      );
      expect(deletes).toContain('DELETE FROM "sessions" WHERE id = $1');
      fail = false;
      const targets = await Promise.all([
        vectors.ensureVectorModel(identity),
        vectors.ensureVectorModel(identity),
      ]);
      expect(targets[0]).toEqual(targets[1]);
      expect(rows).toHaveLength(1);
      expect(physical).toBe(true);
      await deletePgSessionCascade(
        tx as unknown as Parameters<typeof deletePgSessionCascade>[0],
        "indexed",
      );
      expect(deletes).toContain(
        'DELETE FROM "vec_mem_m1" WHERE session_id = $1',
      );
    });
  }
});
