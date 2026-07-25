/**
 * Regression test: in local (browser-IDB) mode the state-patch list is cached
 * in memory, and that cache is empty after a page reload. `addStatePatch` used
 * to append to the empty cache and write the result back to IDB, overwriting
 * the whole persisted array — the session's entire state history destroyed by
 * the first turn after a refresh.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StatePatchRecord } from "../api/types.js";

const idb = vi.hoisted(() => {
  const patches = new Map<string, StatePatchRecord[]>();
  return {
    patches,
    getStatePatches: vi.fn(async (id: string) => patches.get(id) ?? null),
    saveStatePatches: vi.fn(async (id: string, next: StatePatchRecord[]) => {
      patches.set(id, next);
    }),
    removeStatePatches: vi.fn(async (id: string) => {
      patches.delete(id);
    }),
  };
});

vi.mock("../app-kv-store.js", () => ({
  getStatePatches: idb.getStatePatches,
  saveStatePatches: idb.saveStatePatches,
  removeStatePatches: idb.removeStatePatches,
  getStateSnapshot: vi.fn(async () => null),
  saveStateSnapshot: vi.fn(async () => {}),
  removeStateSnapshot: vi.fn(async () => {}),
  getSubmittedBlocks: vi.fn(async () => null),
  saveSubmittedBlocks: vi.fn(async () => {}),
  removeSubmittedBlocks: vi.fn(async () => {}),
  getWorldOverlay: vi.fn(async () => null),
  saveWorldOverlay: vi.fn(async () => {}),
  migrateLocalStorageToIdb: vi.fn(async () => {}),
}));

const { LocalDataService } = await import("../data-service/local.js");

function patch(id: string): StatePatchRecord {
  return {
    id,
    sessionId: "sess-1",
    summary: `patch ${id}`,
    packageName: "test",
    createdAt: "2026-07-25T00:00:00Z",
  };
}

beforeEach(() => {
  idb.patches.clear();
  vi.clearAllMocks();
});

describe("LocalDataService state patches", () => {
  it("keeps persisted history when appending after a reload", async () => {
    idb.patches.set("sess-1", [patch("p1"), patch("p2")]);

    // A fresh instance models the post-reload state: empty in-memory cache.
    const ds = new LocalDataService();
    await ds.addStatePatch("sess-1", patch("p3"));

    expect(idb.patches.get("sess-1")?.map((p) => p.id)).toEqual([
      "p1",
      "p2",
      "p3",
    ]);
    expect((await ds.listStatePatches("sess-1")).map((p) => p.id)).toEqual([
      "p1",
      "p2",
      "p3",
    ]);
  });

  it("appends in order across several writes", async () => {
    const ds = new LocalDataService();
    await ds.addStatePatch("sess-1", patch("a"));
    await ds.addStatePatch("sess-1", patch("b"));

    expect(idb.patches.get("sess-1")?.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("does not lose a patch when appends race in the same tick", async () => {
    // One turn commits several `state.changed` events in a single flush and
    // `sse-handler` calls this fire-and-forget per event.
    idb.patches.set("sess-1", [patch("p0")]);
    const ds = new LocalDataService();

    await Promise.all([
      ds.addStatePatch("sess-1", patch("a")),
      ds.addStatePatch("sess-1", patch("b")),
    ]);

    expect(
      (await ds.listStatePatches("sess-1")).map((p) => p.id).sort(),
    ).toEqual(["a", "b", "p0"]);
    expect(
      idb.patches
        .get("sess-1")
        ?.map((p) => p.id)
        .sort(),
    ).toEqual(["a", "b", "p0"]);
  });

  it("does not lose a patch when appends race on a warm cache", async () => {
    const ds = new LocalDataService();
    await ds.addStatePatch("sess-1", patch("w0")); // warms the cache

    await Promise.all([
      ds.addStatePatch("sess-1", patch("w1")),
      ds.addStatePatch("sess-1", patch("w2")),
    ]);

    expect(
      (await ds.listStatePatches("sess-1")).map((p) => p.id).sort(),
    ).toEqual(["w0", "w1", "w2"]);
  });

  it("reads persisted history without an append", async () => {
    idb.patches.set("sess-1", [patch("p1")]);

    const ds = new LocalDataService();

    expect((await ds.listStatePatches("sess-1")).map((p) => p.id)).toEqual([
      "p1",
    ]);
  });
});
