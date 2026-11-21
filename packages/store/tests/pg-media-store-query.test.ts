import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { createPgMediaStoreFromClient } from "../src/media-store/pg.js";
import { toUint8Array } from "../src/contract/media-store-contract.js";

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
    await store.exists("asset-1");

    expect(queries).toHaveLength(2);
    expect(queries[0]).not.toMatch(/SELECT .*\bbody\b/i);
    expect(queries[1]).toMatch(/^SELECT body IS NOT NULL AS has_body/i);
  });

  it("loads only the body column for get", async () => {
    const { sql, queries } = createSqlRecorder();
    const store = createPgMediaStoreFromClient(sql);

    const bytes = await store.get({
      id: "asset-1",
      mime: "image/png",
      size: 3,
    });

    expect([...(await toUint8Array(bytes))]).toEqual([1, 2, 3]);
    expect(queries).toEqual([
      "SELECT body FROM media_assets WHERE id = ? LIMIT 1",
    ]);
  });

  it("does not claim ownership of an injected client", () => {
    const { sql } = createSqlRecorder();
    expect(createPgMediaStoreFromClient(sql).close).toBeUndefined();
  });

  it("refreshes created_at on conflict in put, addRef, and claimAssets", async () => {
    const queries: string[] = [];
    const runQuery = (strings: TemplateStringsArray) => {
      const query = strings.join("?").replace(/\s+/g, " ").trim();
      queries.push(query);
      if (query.startsWith("SELECT DISTINCT hashtext")) {
        return Promise.resolve([{ key: 123 }]);
      }
      return Promise.resolve([]);
    };
    const tx = Object.assign(runQuery, {
      json: (v: unknown) => v,
    });
    const sql = Object.assign(runQuery, {
      begin: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
    }) as unknown as Sql;
    const store = createPgMediaStoreFromClient(sql);

    const ref = await store.put(
      new Uint8Array([1, 2, 3]),
      "image/png",
      undefined,
      {
        sessionId: "world-data-import:1",
        pluginId: "p1",
      },
    );
    await store.addRef(ref.id, "world-data-import:1", "p2");
    await store.claimAssets([
      { id: ref.id, sessionId: "world-data-import:1", pluginId: "p3" },
    ]);

    const refInserts = queries.filter((q) =>
      q.startsWith("INSERT INTO media_refs"),
    );
    expect(refInserts).toHaveLength(3);
    for (const stmt of refInserts) {
      expect(stmt).toContain(
        "ON CONFLICT (session_id, media_id) DO UPDATE SET created_at = EXCLUDED.created_at",
      );
      expect(stmt).not.toContain("DO NOTHING");
    }
  });

  it("serializes expired-ref deletion and asset deletion under per-asset advisory lock transactions", async () => {
    const oldTime = "2026-01-01T00:00:00.000Z";
    const transactions: Array<string[]> = [];
    const topLevelQueries: string[] = [];

    const makeRunner = (sink: string[]) => (strings: TemplateStringsArray) => {
      const query = strings.join("?").replace(/\s+/g, " ").trim();
      sink.push(query);
      if (query.startsWith("SELECT id, mime, size, meta")) {
        return Promise.resolve([
          {
            id: "asset-orphan",
            mime: "image/png",
            size: 10,
            meta: null,
            owner_session_id: null,
            owner_plugin_id: null,
            created_at: oldTime,
          },
          {
            id: "asset-shared",
            mime: "image/png",
            size: 20,
            meta: null,
            owner_session_id: null,
            owner_plugin_id: null,
            created_at: oldTime,
          },
        ]);
      }
      if (query.startsWith("SELECT media_id, session_id, plugin_id")) {
        return Promise.resolve([
          {
            media_id: "asset-orphan",
            session_id: "world-data-import:old",
            plugin_id: null,
            created_at: oldTime,
          },
          {
            media_id: "asset-shared",
            session_id: "world-data-import:old",
            plugin_id: null,
            created_at: oldTime,
          },
          {
            media_id: "asset-shared",
            session_id: "sess-live",
            plugin_id: null,
            created_at: oldTime,
          },
        ]);
      }
      if (query.startsWith("DELETE FROM media_refs")) {
        return Promise.resolve([{ media_id: "deleted" }]);
      }
      if (query.startsWith("DELETE FROM media_assets")) {
        return Promise.resolve([{ id: "asset-orphan" }]);
      }
      return Promise.resolve([]);
    };

    const sql = Object.assign(makeRunner(topLevelQueries), {
      begin: async <T>(fn: (tx: unknown) => Promise<T>) => {
        const txQueries: string[] = [];
        transactions.push(txQueries);
        return fn(makeRunner(txQueries));
      },
    }) as unknown as Sql;

    const store = createPgMediaStoreFromClient(sql);
    const result = await store.cleanup(new Set(), {
      maxAgeMs: 0,
      expireRefs: {
        sessionIdPrefix: "world-data-import:",
        maxAgeMs: 1000,
      },
      now: new Date("2026-01-02T00:00:00.000Z"),
    });

    // No ref or asset DELETE may execute outside an advisory-locked transaction.
    expect(topLevelQueries.filter((q) => q.startsWith("DELETE FROM"))).toEqual(
      [],
    );
    expect(transactions).toHaveLength(2);

    const orphanTx = transactions.find((tx) =>
      tx.some((q) => q.startsWith("DELETE FROM media_assets")),
    );
    const sharedTx = transactions.find(
      (tx) => !tx.some((q) => q.startsWith("DELETE FROM media_assets")),
    );
    expect(orphanTx).toEqual([
      "SELECT pg_advisory_xact_lock(1129270860, hashtext(?))",
      expect.stringMatching(/^DELETE FROM media_refs\b/),
      expect.stringMatching(/^DELETE FROM media_assets\b/),
    ]);
    expect(sharedTx).toEqual([
      "SELECT pg_advisory_xact_lock(1129270860, hashtext(?))",
      expect.stringMatching(/^DELETE FROM media_refs\b/),
    ]);
    expect(result.deletedIds).toEqual(["asset-orphan"]);
    expect(result.expiredRefs).toHaveLength(2);
  });
});
