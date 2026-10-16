import { randomInt } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

// Uniqueness needs real draws; production IDs take them from `ctx.random`.
const random = { int: randomInt };

describe("entity ID allocation", () => {
  it("does not reuse IDs after reloading the allocator", async () => {
    const labels = [
      "林若风",
      "🔥",
      "Dragon Sword",
      "a".repeat(30),
      "a".repeat(31),
    ];
    const first = await import("@covel/plugin-handlers-utils");
    const before = first.shortIdBatch("item", labels, "session", random);
    vi.resetModules();
    const restarted = await import("@covel/plugin-handlers-utils");
    const after = restarted.shortIdBatch("item", labels, "session", random);
    expect(new Set([...before, ...after]).size).toBe(labels.length * 2);
    expect(before.every((id) => /^item-[a-z0-9-]+$/.test(id))).toBe(true);
  });

  it("keeps the label's ASCII words and a short random part", async () => {
    const { shortId } = await import("@covel/plugin-handlers-utils");
    expect(shortId("npc", "林若风", "s", random)).toMatch(/^npc-[0-9a-f]{8}$/);
    expect(shortId("item", "Dragon Sword!", "s", random)).toMatch(
      /^item-dragon-sword-[0-9a-f]{8}$/,
    );
    expect(shortId("item", "🔥", "s", random)).toMatch(/^item-[0-9a-f]{8}$/);
  });

  it("keeps repeated labels and lossy slugs distinct across batches", async () => {
    const { shortIdBatch } = await import("@covel/plugin-handlers-utils");
    const labels = ["Fire!", "Fire?", "Fire", "Fire", "火", "水"];
    const ids = [
      ...shortIdBatch("entry", labels, "session", random),
      ...shortIdBatch("entry", labels, "session", random),
    ];
    expect(new Set(ids).size).toBe(labels.length * 2);
  });

  it("takes the random part from the given source", async () => {
    const { shortId } = await import("@covel/plugin-handlers-utils");
    expect(shortId("npc", "Lin", "s", { int: () => 0xabc })).toBe(
      "npc-lin-00000abc",
    );
  });

  it("allocates word-only IDs that skip taken ones", async () => {
    const { wordId } = await import("@covel/plugin-handlers-utils");
    expect(wordId("char", "Tomas Reed", new Set())).toBe("char-tomas-reed");
    expect(wordId("codex", "西侧旧药园", new Set())).toMatch(
      /^codex-[0-9a-f]{8}$/,
    );
    expect(wordId("char", "Lin", new Set(["char-lin", "char-lin-2"]))).toBe(
      "char-lin-3",
    );
  });

  it("gives a label without ASCII words the same ID in every session", async () => {
    const { wordId } = await import("@covel/plugin-handlers-utils");
    const first = wordId("npc", "雷恩修女", new Set());
    vi.resetModules();
    const restarted = await import("@covel/plugin-handlers-utils");
    expect(restarted.wordId("npc", " 雷恩修女 ", new Set())).toBe(first);
    expect(restarted.wordId("npc", "村长", new Set())).not.toBe(first);
    expect(restarted.wordId("npc", "雷恩修女", new Set([first]))).toBe(
      `${first}-2`,
    );
  });
});
