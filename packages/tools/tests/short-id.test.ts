import { describe, expect, it, vi } from "vitest";

describe("entity ID allocation", () => {
  it("does not reuse IDs after reloading the allocator", async () => {
    const labels = [
      "林若风",
      "🔥",
      "Dragon Sword",
      "a".repeat(30),
      "a".repeat(31),
    ];
    const first = await import("../src/short-id.js");
    const before = first.shortIdBatch("item", labels, "session");
    vi.resetModules();
    const restarted = await import("../src/short-id.js");
    const after = restarted.shortIdBatch("item", labels, "session");
    expect(new Set([...before, ...after]).size).toBe(labels.length * 2);
    expect(before.every((id) => /^item-[a-z0-9-]+$/.test(id))).toBe(true);
  });

  it("keeps repeated labels and lossy slugs distinct across batches", async () => {
    const { shortIdBatch } = await import("../src/short-id.js");
    const labels = ["Fire!", "Fire?", "Fire", "Fire", "火", "水"];
    const ids = [
      ...shortIdBatch("entry", labels, "session"),
      ...shortIdBatch("entry", labels, "session"),
    ];
    expect(new Set(ids).size).toBe(labels.length * 2);
  });
});
