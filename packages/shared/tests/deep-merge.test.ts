import { describe, it, expect } from "vitest";
import { deepMerge } from "../src/utils/deep-merge.js";

describe("deepMerge", () => {
  // ── Basic merging ────────────────────────────────────────────────
  it("merges flat objects", () => {
    const result = deepMerge({ a: 1 }, { b: 2 });
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it("overwrites same-key primitive values from source", () => {
    const result = deepMerge({ a: 1 }, { a: 2 });
    expect(result).toEqual({ a: 2 });
  });

  // ── Nested merging ──────────────────────────────────────────────
  it("deep-merges nested objects", () => {
    const result = deepMerge(
      { player: { hp: 100, gold: 50 } },
      { player: { hp: 80 } },
    );
    expect(result).toEqual({ player: { hp: 80, gold: 50 } });
  });

  it("deep-merges multiple levels", () => {
    const result = deepMerge(
      { a: { b: { c: 1, d: 2 } } },
      { a: { b: { c: 3 } } },
    );
    expect(result).toEqual({ a: { b: { c: 3, d: 2 } } });
  });

  // ── Arrays are overwritten (not merged) ─────────────────────────
  it("overwrites arrays from source (no array merge)", () => {
    const result = deepMerge(
      { tags: ["a", "b"] },
      { tags: ["c"] },
    );
    expect(result).toEqual({ tags: ["c"] });
  });

  it("shallow-copies arrays to prevent mutation", () => {
    const sourceArr = [1, 2, 3];
    const result = deepMerge({ arr: [0] }, { arr: sourceArr });
    (result.arr as number[]).push(4);
    expect(sourceArr).toEqual([1, 2, 3]); // source array not mutated
  });

  // ── Null / undefined handling ───────────────────────────────────
  it("source null overwrites target object", () => {
    const result = deepMerge({ a: { nested: true } }, { a: null as unknown as Record<string, unknown> });
    expect(result).toEqual({ a: null });
  });

  it("source value overwrites target null", () => {
    const result = deepMerge(
      { a: null } as unknown as Record<string, unknown>,
      { a: { nested: true } },
    );
    expect(result).toEqual({ a: { nested: true } });
  });

  // ── Immutability ────────────────────────────────────────────────
  it("does not mutate target", () => {
    const target = { a: 1, b: { c: 2 } };
    const source = { b: { d: 3 } };
    deepMerge(target, source);
    expect(target).toEqual({ a: 1, b: { c: 2 } });
  });

  it("does not mutate source", () => {
    const target = { a: 1 };
    const source = { b: { c: 2 } };
    deepMerge(target, source);
    expect(source).toEqual({ b: { c: 2 } });
  });

  // ── Empty objects ───────────────────────────────────────────────
  it("returns copy of target when source is empty", () => {
    const result = deepMerge({ a: 1 }, {});
    expect(result).toEqual({ a: 1 });
  });

  it("returns copy of source when target is empty", () => {
    const result = deepMerge({}, { a: 1 });
    expect(result).toEqual({ a: 1 });
  });

  // ── Max depth safety ────────────────────────────────────────────
  it("falls back to shallow merge at max depth (20)", () => {
    // Build a 25-level deep object
    let target: Record<string, unknown> = { leaf: "target" };
    let source: Record<string, unknown> = { leaf: "source", extra: true };
    for (let i = 0; i < 25; i++) {
      target = { nested: target };
      source = { nested: source };
    }
    // Should not throw, and at depth >= 20 falls back to shallow
    const result = deepMerge(target, source);
    expect(result).toBeDefined();
    // At depth 20, the inner objects are shallow-spread instead of recursed
    // So the deepest "leaf" should be from source
    let node: Record<string, unknown> = result;
    for (let i = 0; i < 25; i++) {
      node = node.nested as Record<string, unknown>;
    }
    expect(node.leaf).toBe("source");
  });

  // ── Mixed types ─────────────────────────────────────────────────
  it("source object overwrites target primitive", () => {
    const result = deepMerge({ a: 1 }, { a: { nested: true } });
    expect(result).toEqual({ a: { nested: true } });
  });

  it("source primitive overwrites target object", () => {
    const result = deepMerge({ a: { nested: true } }, { a: 42 });
    expect(result).toEqual({ a: 42 });
  });
});
