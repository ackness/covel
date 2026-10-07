import { describe, expect, it } from "vitest";
import {
  checkCollection,
  collectionPluginFacts,
  type CollectionPluginFacts,
} from "../src/collection-check.js";

describe("collection plugin contract completeness", () => {
  const consumer = collectionPluginFacts({
    id: "observer",
    requires: ["narrative-engine@1"],
    optional: ["world-time-context@1"],
  });

  it("reports a missing plugin requirement even without a world", () => {
    expect(
      checkCollection({ worlds: [], plugins: [consumer], available: [] }),
    ).toEqual([
      {
        level: "error",
        packageId: "observer",
        message:
          "Plugin observer requires narrative-engine@1, and no installed or included plugin provides it.",
      },
    ]);
  });

  it.each(["included", "installed"])("accepts an %s provider", (source) => {
    const provider = collectionPluginFacts({
      id: "story",
      provides: [{ contract: "narrative-engine@1" }],
    });
    expect(
      checkCollection({
        worlds: [],
        plugins: source === "included" ? [consumer, provider] : [consumer],
        available: source === "installed" ? [provider] : [],
      }),
    ).toEqual([]);
  });

  it("requires the exact contract version and checks every included plugin", () => {
    const observer: CollectionPluginFacts = {
      ...consumer,
      id: "second-observer",
    };
    expect(
      checkCollection({
        worlds: [],
        plugins: [consumer, observer],
        available: [{ id: "story", contracts: ["narrative-engine@2"] }],
      }),
    ).toEqual([
      expect.objectContaining({ level: "error", packageId: "observer" }),
      expect.objectContaining({ level: "error", packageId: "second-observer" }),
    ]);
  });
});
