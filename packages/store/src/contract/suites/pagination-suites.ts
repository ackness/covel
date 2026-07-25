import { beforeEach, describe, expect, it } from "vitest";
import type { DataStore } from "../../types.js";
import {
  makeMessage,
  makeRuntimeOutput,
  makeTraceEvent,
  ts,
} from "../test-fixtures.js";

/**
 * Offset-pagination completeness for the lists the media GC pages through.
 *
 * `buildProtectedMediaIds` walks each of these with `{ limit, offset }` to
 * collect the asset ids that are still referenced. Two ways that walk can
 * betray it, both of which cost real data:
 *
 *  - a row skipped between pages never contributes its media id, so the sweep
 *    deletes bytes that are still in use (unrecoverable);
 *  - an ignored `offset` re-serves page 0 forever, so the scan never
 *    terminates and cleanup dies on the row cap instead.
 *
 * The contract is therefore per-backend completeness — every row seen exactly
 * once, and the walk terminates — not a shared ordering between backends.
 * Rows deliberately share one timestamp so the tie-break carries the order.
 *
 * Scope, honestly: this catches a dropped `offset` (verified: removing it makes
 * the walk spin until the guard fires). It does NOT reproduce the skip that
 * motivates the ORDER BY — that needs PG to physically reorder tuples mid-walk,
 * which a ten-row single-page table will not do on demand. The ORDER BY rests
 * on the documented rule that LIMIT/OFFSET without ORDER BY returns an
 * unpredictable subset; treat these tests as a regression guard for the
 * contract, not as proof of the race.
 */
export function registerPaginationStoreSuites(getStore: () => DataStore): void {
  let store: DataStore;

  const PAGE_SIZE = 3;
  const ROW_COUNT = 10; // not a multiple of PAGE_SIZE — exercises a short last page
  const SHARED_TS = ts();

  beforeEach(() => {
    store = getStore();
  });

  /** Mirrors the GC's scan loop, with a guard so a dropped offset fails fast. */
  async function collectPaged<T>(
    load: (pagination: {
      readonly limit: number;
      readonly offset: number;
    }) => Promise<readonly T[]>,
  ): Promise<T[]> {
    const seen: T[] = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const rows = await load({ limit: PAGE_SIZE, offset });
      seen.push(...rows);
      if (rows.length < PAGE_SIZE) return seen;
      if (seen.length > ROW_COUNT * 3) {
        throw new Error(
          "pagination never terminated — the loader is ignoring `offset`",
        );
      }
    }
  }

  function expectEachRowOnce(ids: readonly string[]): void {
    expect(ids).toHaveLength(ROW_COUNT);
    expect(new Set(ids).size).toBe(ROW_COUNT);
  }

  describe("Offset pagination completeness (media GC scan surfaces)", () => {
    it("pages through messages without skipping or repeating a row", async () => {
      for (let i = 0; i < ROW_COUNT; i += 1) {
        await store.addMessage(
          makeMessage({ sessionId: "sess-page", createdAt: SHARED_TS }),
        );
      }
      const rows = await collectPaged((p) =>
        store.listMessages("sess-page", p),
      );
      expectEachRowOnce(rows.map((r) => r.id));
    });

    it("pages through session-scoped plugin data without skipping or repeating a row", async () => {
      for (let i = 0; i < ROW_COUNT; i += 1) {
        await store.setPluginData({
          id: `pd-page-${i}`,
          sessionId: "sess-page",
          pluginId: "plugin-a",
          namespace: "ns",
          key: `key-${i}`,
          value: { i },
          createdAt: SHARED_TS,
          updatedAt: SHARED_TS,
        });
      }
      const rows = await collectPaged((p) =>
        store.listPluginDataSessionScope("sess-page", p),
      );
      expectEachRowOnce(rows.map((r) => r.id));
    });

    it("pages through trace events without skipping or repeating a row", async () => {
      for (let i = 0; i < ROW_COUNT; i += 1) {
        await store.addTraceEvent(
          makeTraceEvent({ sessionId: "sess-page", createdAt: SHARED_TS }),
        );
      }
      const rows = await collectPaged((p) =>
        store.listTraceEvents("sess-page", p),
      );
      expectEachRowOnce(rows.map((r) => r.id));
    });

    it("pages through runtime outputs without skipping or repeating a row", async () => {
      for (let i = 0; i < ROW_COUNT; i += 1) {
        await store.saveRuntimeOutput(
          makeRuntimeOutput({ sessionId: "sess-page", timestamp: SHARED_TS }),
        );
      }
      const rows = await collectPaged((p) =>
        store.listRuntimeOutputs("sess-page", p),
      );
      expectEachRowOnce(rows.map((r) => r.id));
    });
  });
}
