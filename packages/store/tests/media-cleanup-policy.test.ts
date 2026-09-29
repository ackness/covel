import type { MediaAssetRecord } from "@covel/shared";
import { describe, expect, it } from "vitest";
import { cleanupCandidates } from "../src/media-store/cleanup-policy.js";

function asset(id: string, createdAt: string): MediaAssetRecord {
  return {
    id,
    createdAt,
    size: 10,
    mime: "image/png",
    ownerSessionId: null,
    ownerPluginId: null,
  };
}

describe("media cleanup policy", () => {
  it("applies age, recent-byte, and total-byte limits in order while preserving protected assets", () => {
    const assets = [
      asset("newest", "2024-01-05T00:00:00.000Z"),
      asset("old", "2024-01-01T00:00:00.000Z"),
      asset("protected", "2024-01-01T00:00:00.000Z"),
      asset("recent", "2024-01-04T00:00:00.000Z"),
      asset("older", "2024-01-03T00:00:00.000Z"),
    ];

    const plan = cleanupCandidates(assets, new Set(["protected"]), {
      now: new Date("2024-01-06T00:00:00.000Z"),
      maxAgeMs: 4 * 24 * 60 * 60 * 1000,
      keepRecentBytes: 15,
      maxBytes: 15,
    });

    expect(plan).toEqual({
      idsToDelete: ["old", "recent", "older", "newest"],
      result: {
        scanned: 5,
        protected: 1,
        retained: 1,
        deleted: 4,
        totalBytes: 50,
        bytesDeleted: 40,
        bytesRetained: 10,
        protectedIds: ["protected"],
        deletedIds: ["old", "recent", "older", "newest"],
      },
    });
    expect(assets.map((record) => record.id)).toEqual([
      "newest",
      "old",
      "protected",
      "recent",
      "older",
    ]);
  });
});
