import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { createPgMediaStoreFromClient } from "../src/media-store/pg.js";

function createSqlRecorder() {
  const queries: string[] = [];
  const sql = (strings: TemplateStringsArray) => {
    const query = strings.join("?").replace(/\s+/g, " ").trim();
    queries.push(query);
    if (query.includes("body IS NOT NULL")) {
      return Promise.resolve([{ has_body: true }]);
    }
    if (query.includes("SELECT body")) {
      return Promise.resolve([{ body: Buffer.from([1, 2, 3]) }]);
    }
    return Promise.resolve([
      {
        id: "asset-1",
        mime: "image/png",
        size: 3,
        meta: null,
        owner_session_id: null,
        owner_plugin_id: null,
      },
    ]);
  };
  return { sql: sql as unknown as Sql, queries };
}

describe("PgMediaStore query projections", () => {
  it("does not load bytea bodies for metadata-only operations", async () => {
    const { sql, queries } = createSqlRecorder();
    const store = createPgMediaStoreFromClient(sql);

    await store.lookup("asset-1");
    await store.resolveUrl({ id: "asset-1", mime: "image/png", size: 3 });
    await store.exists("asset-1");

    expect(queries).toHaveLength(3);
    expect(queries[0]).not.toMatch(/SELECT .*\bbody\b/i);
    expect(queries[1]).not.toMatch(/SELECT .*\bbody\b/i);
    expect(queries[2]).toMatch(/^SELECT body IS NOT NULL AS has_body/i);
  });

  it("loads only the body column for get", async () => {
    const { sql, queries } = createSqlRecorder();
    const store = createPgMediaStoreFromClient(sql);

    const bytes = await store.get({
      id: "asset-1",
      mime: "image/png",
      size: 3,
    });

    expect([...bytes]).toEqual([1, 2, 3]);
    expect(queries).toEqual([
      "SELECT body FROM media_assets WHERE id = ? LIMIT 1",
    ]);
  });

  it("does not claim ownership of an injected client", () => {
    const { sql } = createSqlRecorder();
    expect(createPgMediaStoreFromClient(sql).close).toBeUndefined();
  });
});
