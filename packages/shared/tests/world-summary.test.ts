import { describe, expect, it } from "vitest";
import { summarizeWorld, worldSummarySchema } from "../src/index.js";

const full = {
  id: "w",
  name: "World",
  description: "A world.",
  lore: "Long lore text.",
  tags: ["a"],
  locale: "en-US",
  dimensions: { geography: { name: "Geography", schema: {} } },
  createdAt: "2026-01-01T00:00:00.000Z",
  metadata: {
    source: "file",
    cover: "media/gallery/cover.webp",
    accentColor: "#336699",
    supportedLocales: ["en-US", "zh-CN"],
    pluginSettings: { dice: { sides: 20 } },
    localizedText: {
      name: { "zh-CN": "世界" },
      description: { "zh-CN": "一个世界。" },
      lore: { "zh-CN": "很长的设定。" },
    },
    dimensions: { geography: {} },
    embeddedCharacters: [{ id: "c" }],
    embeddedLorebook: [{ id: "l" }],
    characterSchema: { fields: [] },
    pluginPolicy: { requested: ["x"] },
    worldData: { sources: [] },
  },
};

describe("summarizeWorld", () => {
  it("drops the lore, the dimensions and the large metadata", () => {
    const summary = summarizeWorld(full);
    expect(summary).not.toHaveProperty("lore");
    expect(summary).not.toHaveProperty("dimensions");
    expect(Object.keys(summary.metadata ?? {}).sort()).toEqual([
      "accentColor",
      "cover",
      "localizedText",
      "pluginSettings",
      "source",
      "supportedLocales",
    ]);
    // Names and descriptions in other languages stay; lore translations go.
    expect(summary.metadata?.localizedText).toEqual({
      name: { "zh-CN": "世界" },
      description: { "zh-CN": "一个世界。" },
    });
    expect(worldSummarySchema.parse(summary)).toEqual(summary);
  });

  it("returns an equal summary when applied to a summary", () => {
    const once = summarizeWorld(full);
    expect(summarizeWorld(once)).toEqual(once);
  });

  it("keeps a world without metadata free of it", () => {
    const { metadata: _metadata, ...bare } = full;
    expect(summarizeWorld(bare)).not.toHaveProperty("lore");
    expect(
      (summarizeWorld(bare) as { metadata?: unknown }).metadata,
    ).toBeUndefined();
  });
});
