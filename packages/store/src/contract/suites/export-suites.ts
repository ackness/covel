/**
 * Contract suite for runtime exports (`output.recordAs` publications):
 *   - append idempotency (a re-published revision is a no-op, no overwrite);
 *   - getLatest picks the highest revision, with `atOrBefore` frozen reads;
 *   - list ordering (producerRuntimeId, recordAs, revision asc) + filters;
 *   - `value` JsonValue round-trip (nested / null boundaries);
 *   - session cascade delete covers the new table.
 *
 * Every backend runs this shared suite, so any SQLite/PG/Memory/IDB divergence
 * fails CI — backend parity is a hard contract.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { DataStore } from "../../types.js";
import { makeRuntimeExport, makeSession, ts } from "../test-fixtures.js";

export function registerExportStoreSuites(getStore: () => DataStore): void {
  let store: DataStore;

  beforeEach(() => {
    store = getStore();
  });

  describe("RuntimeExports append", () => {
    it("appends once, rejects a duplicate revision without overwriting", async () => {
      const first = makeRuntimeExport({
        sessionId: "sess-rx",
        producerRuntimeId: "r/gen",
        recordAs: "schema",
        revision: 1,
        resultId: "res-1",
      });
      expect(await store.appendRuntimeExport(first)).toBe(true);

      const dup = makeRuntimeExport({
        sessionId: "sess-rx",
        producerRuntimeId: "r/gen",
        recordAs: "schema",
        revision: 1,
        resultId: "res-2",
        value: { ok: false },
      });
      expect(await store.appendRuntimeExport(dup)).toBe(false);

      const latest = await store.getLatestRuntimeExport(
        "sess-rx",
        "r/gen",
        "schema",
      );
      // The rejected duplicate must not have overwritten the original.
      expect(latest?.resultId).toBe("res-1");
      expect(latest?.value).toEqual({ ok: true });
    });

    it("isolates exports between sessions on the same key", async () => {
      await store.appendRuntimeExport(
        makeRuntimeExport({
          sessionId: "sess-A",
          producerRuntimeId: "r",
          recordAs: "k",
          revision: 1,
        }),
      );
      // Same (runtime, recordAs, revision), different session — fresh insert.
      expect(
        await store.appendRuntimeExport(
          makeRuntimeExport({
            sessionId: "sess-B",
            producerRuntimeId: "r",
            recordAs: "k",
            revision: 1,
          }),
        ),
      ).toBe(true);
    });
  });

  describe("RuntimeExports getLatest", () => {
    it("returns null when no export matches", async () => {
      expect(
        await store.getLatestRuntimeExport("sess-none", "r", "k"),
      ).toBeNull();
    });

    it("returns the highest revision", async () => {
      for (const revision of [1, 2, 3]) {
        await store.appendRuntimeExport(
          makeRuntimeExport({
            sessionId: "sess-latest",
            producerRuntimeId: "r/gen",
            recordAs: "schema",
            revision,
            resultId: `res-${revision}`,
          }),
        );
      }
      const latest = await store.getLatestRuntimeExport(
        "sess-latest",
        "r/gen",
        "schema",
      );
      expect(latest?.revision).toBe(3);
      expect(latest?.resultId).toBe("res-3");
    });

    it("freezes the read at atOrBefore (latest committed at-or-before an instant)", async () => {
      const t1 = ts(0);
      const t2 = ts(1000);
      const t3 = ts(2000);
      await store.appendRuntimeExport(
        makeRuntimeExport({
          sessionId: "sess-frozen",
          producerRuntimeId: "r/gen",
          recordAs: "schema",
          revision: 1,
          committedAt: t1,
        }),
      );
      await store.appendRuntimeExport(
        makeRuntimeExport({
          sessionId: "sess-frozen",
          producerRuntimeId: "r/gen",
          recordAs: "schema",
          revision: 2,
          committedAt: t2,
        }),
      );
      await store.appendRuntimeExport(
        makeRuntimeExport({
          sessionId: "sess-frozen",
          producerRuntimeId: "r/gen",
          recordAs: "schema",
          revision: 3,
          committedAt: t3,
        }),
      );

      // A consumer that started at t2 must not see revision 3 (committed at t3).
      const frozen = await store.getLatestRuntimeExport(
        "sess-frozen",
        "r/gen",
        "schema",
        { atOrBefore: t2 },
      );
      expect(frozen?.revision).toBe(2);

      // Before the first commit — nothing is visible.
      const beforeAll = await store.getLatestRuntimeExport(
        "sess-frozen",
        "r/gen",
        "schema",
        { atOrBefore: ts(-1000) },
      );
      expect(beforeAll).toBeNull();
    });
  });

  describe("RuntimeExports list", () => {
    it("orders by (producerRuntimeId, recordAs, revision) ascending", async () => {
      await store.appendRuntimeExport(
        makeRuntimeExport({
          sessionId: "sess-list",
          producerRuntimeId: "b",
          recordAs: "k",
          revision: 1,
        }),
      );
      await store.appendRuntimeExport(
        makeRuntimeExport({
          sessionId: "sess-list",
          producerRuntimeId: "a",
          recordAs: "k",
          revision: 2,
        }),
      );
      await store.appendRuntimeExport(
        makeRuntimeExport({
          sessionId: "sess-list",
          producerRuntimeId: "a",
          recordAs: "k",
          revision: 1,
        }),
      );
      const rows = await store.listRuntimeExports("sess-list");
      expect(rows.map((r) => [r.producerRuntimeId, r.revision])).toEqual([
        ["a", 1],
        ["a", 2],
        ["b", 1],
      ]);
    });

    it("filters by producerRuntimeId and recordAs", async () => {
      await store.appendRuntimeExport(
        makeRuntimeExport({
          sessionId: "sess-filter",
          producerRuntimeId: "r1",
          recordAs: "k1",
          revision: 1,
        }),
      );
      await store.appendRuntimeExport(
        makeRuntimeExport({
          sessionId: "sess-filter",
          producerRuntimeId: "r2",
          recordAs: "k2",
          revision: 1,
        }),
      );
      expect(
        await store.listRuntimeExports("sess-filter", {
          producerRuntimeId: "r1",
        }),
      ).toHaveLength(1);
      expect(
        await store.listRuntimeExports("sess-filter", { recordAs: "k2" }),
      ).toHaveLength(1);
      expect(await store.listRuntimeExports("sess-filter")).toHaveLength(2);
    });
  });

  describe("RuntimeExports value round-trip", () => {
    it("round-trips a nested JsonValue verbatim (nested null survives)", async () => {
      const value = {
        nested: { a: 1, b: "two", inner: null },
        arr: [1, "x", true, null],
        flag: false,
      };
      await store.appendRuntimeExport(
        makeRuntimeExport({
          sessionId: "sess-json",
          producerRuntimeId: "r",
          recordAs: "k",
          revision: 1,
          value,
        }),
      );
      const latest = await store.getLatestRuntimeExport("sess-json", "r", "k");
      expect(latest?.value).toEqual(value);
    });

    it("round-trips a top-level null value as null (required field)", async () => {
      // `value` is a required JsonValue stored in a nullable column: a top-level
      // JSON null serialises to SQL NULL and must read back as `null`, not
      // undefined, on every backend.
      await store.appendRuntimeExport(
        makeRuntimeExport({
          sessionId: "sess-null",
          producerRuntimeId: "r",
          recordAs: "k",
          revision: 1,
          value: null,
        }),
      );
      const latest = await store.getLatestRuntimeExport("sess-null", "r", "k");
      expect(latest?.value).toBeNull();
    });
  });

  describe("RuntimeExports cascade", () => {
    it("is removed when its session is deleted", async () => {
      const sessionId = "sess-rx-cascade";
      await store.createSession(makeSession({ id: sessionId }));
      await store.appendRuntimeExport(
        makeRuntimeExport({ sessionId, producerRuntimeId: "r", recordAs: "k" }),
      );
      expect(await store.listRuntimeExports(sessionId)).toHaveLength(1);

      await store.deleteSession(sessionId);
      expect(await store.listRuntimeExports(sessionId)).toHaveLength(0);
    });
  });
}
