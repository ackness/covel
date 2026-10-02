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

  it("keeps the label's ASCII words and a short random part", async () => {
    const { shortId } = await import("../src/short-id.js");
    expect(shortId("npc", "林若风", "s")).toMatch(/^npc-[0-9a-f]{8}$/);
    expect(shortId("item", "Dragon Sword!", "s")).toMatch(
      /^item-dragon-sword-[0-9a-f]{8}$/,
    );
    expect(shortId("item", "🔥", "s")).toMatch(/^item-[0-9a-f]{8}$/);
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

  it("allocates word-only IDs that skip taken ones", async () => {
    const { wordId } = await import("../src/short-id.js");
    expect(wordId("char", "Tomas Reed", new Set())).toBe("char-tomas-reed");
    expect(wordId("codex", "西侧旧药园", new Set())).toMatch(
      /^codex-[0-9a-f]{8}$/,
    );
    expect(wordId("char", "Lin", new Set(["char-lin", "char-lin-2"]))).toBe(
      "char-lin-3",
    );
  });
});
