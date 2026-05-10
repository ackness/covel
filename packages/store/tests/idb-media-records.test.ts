import { describe, expect, it } from "vitest";
import {
  cloneMeta,
  type IdbMediaAssetRecord,
  type IdbMediaRefRecord,
  planMediaCleanup,
  refKey,
  sha256,
  sortAssetRecords,
  sortRefRecords,
  toAssetRecord,
  toBlobAndBytes,
  toLookup,
  toMediaRef,
  toRefRecord,
} from "../src/indexeddb/idb-media-records.js";

function mediaAsset(
  overrides: Partial<IdbMediaAssetRecord>,
): IdbMediaAssetRecord {
  return {
    id: "asset",
    mime: "application/octet-stream",
    size: 1,
    blob: new Blob([new Uint8Array([1])], {
      type: "application/octet-stream",
    }),
    ownerSessionId: null,
    ownerPluginId: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function mediaRef(overrides: Partial<IdbMediaRefRecord>): IdbMediaRefRecord {
  return {
    key: "ref",
    mediaId: "asset",
    sessionId: "session",
    pluginId: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("idb-media-records", () => {
  it("normalizes Uint8Array and Blob inputs into browser blobs plus bytes", async () => {
    const bytesInput = new Uint8Array([1, 2, 3]);
    const fromBytes = await toBlobAndBytes(bytesInput, "image/png");
    expect(fromBytes.bytes).toEqual(bytesInput);
    expect(fromBytes.blob.type).toBe("image/png");

    const textBlob = new Blob([new Uint8Array([4, 5])], {
      type: "text/plain",
    });
    const fromBlob = await toBlobAndBytes(textBlob, "image/png");
    expect([...fromBlob.bytes]).toEqual([4, 5]);
    expect(fromBlob.blob.type).toBe("image/png");
  });

  it("hashes bytes using the same SHA-256 id shape as the media store", async () => {
    const digest = await sha256(new TextEncoder().encode("abc"));
    expect(digest).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("maps IndexedDB records to public media records without exposing blobs", () => {
    const record = mediaAsset({
      id: "asset-1",
      mime: "image/png",
      size: 42,
      meta: { prompt: "test" },
      ownerSessionId: "session-1",
      ownerPluginId: "plugin-1",
      createdAt: "2024-01-02T00:00:00.000Z",
    });

    expect(toMediaRef(record)).toEqual({
      id: "asset-1",
      mime: "image/png",
      size: 42,
      meta: { prompt: "test" },
    });
    expect(toLookup(record)).toEqual({
      id: "asset-1",
      mime: "image/png",
      size: 42,
      ownerSessionId: "session-1",
      ownerPluginId: "plugin-1",
    });
    expect(toAssetRecord(record)).toEqual({
      id: "asset-1",
      mime: "image/png",
      size: 42,
      meta: { prompt: "test" },
      ownerSessionId: "session-1",
      ownerPluginId: "plugin-1",
      createdAt: "2024-01-02T00:00:00.000Z",
    });
  });

  it("builds SQL-compatible ref keys and first-writer ref rows", () => {
    const row = mediaRef({
      mediaId: "asset-1",
      sessionId: "session-1",
      pluginId: "plugin-1",
      createdAt: "2024-01-01T00:00:00.000Z",
    });

    expect(refKey("asset-1", "session-1")).toBe("session-1\u0000asset-1");
    expect(toRefRecord(row)).toEqual({
      mediaId: "asset-1",
      sessionId: "session-1",
      pluginId: "plugin-1",
      createdAt: "2024-01-01T00:00:00.000Z",
    });
  });

  it("copies meta objects before storing them", () => {
    const source = { label: "before" };
    const stored = cloneMeta(source);
    source.label = "after";
    expect(stored).toEqual({ label: "before" });
  });

  it("sorts assets and refs using stable IndexedDB list order", () => {
    const sortedAssets = sortAssetRecords([
      toAssetRecord(
        mediaAsset({
          id: "b",
          createdAt: "2024-01-01T00:00:00.000Z",
        }),
      ),
      toAssetRecord(
        mediaAsset({
          id: "a",
          createdAt: "2024-01-01T00:00:00.000Z",
        }),
      ),
      toAssetRecord(
        mediaAsset({
          id: "c",
          createdAt: "2024-01-02T00:00:00.000Z",
        }),
      ),
    ]);
    expect(sortedAssets.map((asset) => asset.id)).toEqual(["a", "b", "c"]);

    const sortedRefs = sortRefRecords([
      toRefRecord(
        mediaRef({
          mediaId: "b",
          sessionId: "session-2",
          createdAt: "2024-01-01T00:00:00.000Z",
        }),
      ),
      toRefRecord(
        mediaRef({
          mediaId: "a",
          sessionId: "session-1",
          createdAt: "2024-01-01T00:00:00.000Z",
        }),
      ),
    ]);
    expect(sortedRefs.map((ref) => `${ref.sessionId}:${ref.mediaId}`)).toEqual([
      "session-1:a",
      "session-2:b",
    ]);
  });

  it("plans cleanup with protected ids and byte budgets", () => {
    const assets = [
      toAssetRecord(
        mediaAsset({
          id: "old",
          size: 40,
          createdAt: "2024-01-01T00:00:00.000Z",
        }),
      ),
      toAssetRecord(
        mediaAsset({
          id: "protected",
          size: 40,
          createdAt: "2024-01-02T00:00:00.000Z",
        }),
      ),
      toAssetRecord(
        mediaAsset({
          id: "new",
          size: 40,
          createdAt: "2024-01-03T00:00:00.000Z",
        }),
      ),
    ];

    const plan = planMediaCleanup(assets, new Set(["protected"]), {
      maxBytes: 80,
      now: new Date("2024-01-04T00:00:00.000Z"),
    });

    expect(plan.idsToDelete).toEqual(["old"]);
    expect(plan.result).toMatchObject({
      scanned: 3,
      protected: 1,
      retained: 2,
      deleted: 1,
      totalBytes: 120,
      bytesDeleted: 40,
      bytesRetained: 80,
      protectedIds: ["protected"],
      deletedIds: ["old"],
    });
  });
});
