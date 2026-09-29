import { describe, expect, it } from "vitest";
import { deepMerge } from "../src/utils/deep-merge.js";

describe("deepMerge", () => {
  it("preserves nested special JSON keys without changing prototypes", () => {
    const source = JSON.parse(
      '{"nested":{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}}',
    );
    const target = { nested: { existing: 1 } };
    const merged = deepMerge(target, source);
    expect(Object.getPrototypeOf(merged.nested)).toBe(Object.prototype);
    expect(Object.hasOwn(merged.nested, "__proto__")).toBe(true);
    expect(JSON.parse(JSON.stringify(merged))).toEqual({
      nested: { existing: 1, ...source.nested },
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(target).toEqual({ nested: { existing: 1 } });
  });

  it("merges only plain objects and replaces arrays and class instances", () => {
    class Value {
      constructor(readonly value: number) {}
    }
    const incoming = new Value(2);
    const result = deepMerge(
      { object: { a: 1 }, array: [1], value: new Value(1) },
      {
        object: Object.assign(Object.create(null), { b: 2 }),
        array: [2],
        value: incoming,
      },
    );
    expect(result.object).toEqual({ a: 1, b: 2 });
    expect(result.array).toEqual([2]);
    expect(result.value).toBe(incoming);
  });
});
