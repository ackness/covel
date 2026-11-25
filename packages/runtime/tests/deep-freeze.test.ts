import { describe, expect, it } from "vitest";
import { deepFreeze } from "../src/utils/deep-freeze.js";

describe("deepFreeze", () => {
  it("freezes nested objects and arrays recursively", () => {
    const value = deepFreeze({
      nested: { count: 1 },
      items: [{ label: "a" }],
    });
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.nested)).toBe(true);
    expect(Object.isFrozen(value.items)).toBe(true);
    expect(Object.isFrozen(value.items[0])).toBe(true);
  });

  it("handles self-referential and mutually cyclic object graphs without overflowing the stack", () => {
    const a: Record<string, unknown> = { name: "a" };
    const b: Record<string, unknown> = { name: "b", peer: a };
    a.self = a;
    a.peer = b;

    const frozen = deepFreeze(a);
    expect(frozen).toBe(a);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(b)).toBe(true);
  });
});
