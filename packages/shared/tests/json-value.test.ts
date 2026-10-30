import { describe, expect, it } from "vitest";
import {
  assertJsonValue,
  isJsonValue,
  toJsonValueOrDiagnostic,
} from "../src/utils/json-value.js";

class CustomValue {
  constructor(readonly value: string) {}
}

describe("JSON value boundaries", () => {
  it("accepts arrays, plain objects, and null-prototype objects", () => {
    const nullPrototype = Object.assign(Object.create(null), {
      nested: [1, "two", true, null],
    });

    expect(isJsonValue({ nested: [1, "two", true, null] })).toBe(true);
    expect(isJsonValue(nullPrototype)).toBe(true);
    expect(() => assertJsonValue(nullPrototype)).not.toThrow();
  });

  it.each([
    ["Date", new Date("2026-01-01T00:00:00.000Z")],
    ["Map", new Map([["key", "value"]])],
    ["Set", new Set(["value"])],
    ["RegExp", /value/],
    ["boxed primitive", new String("value")],
    ["class instance", new CustomValue("value")],
  ])(
    "rejects %s instances instead of silently reshaping them",
    (_name, value) => {
      expect(isJsonValue(value)).toBe(false);
      expect(() => assertJsonValue(value, "payload")).toThrow(
        "payload is not a plain JSON object",
      );
      expect(toJsonValueOrDiagnostic(value, "payload")).toContain(
        "payload is not a plain JSON object",
      );
    },
  );

  it("omits only undefined object properties in audit output without mutating it", () => {
    const value = {
      characters: [{ name: "Ada", description: undefined }],
      entry: { title: "Gate", imageHint: undefined },
    };
    expect(toJsonValueOrDiagnostic(value, "output")).toEqual({
      characters: [{ name: "Ada" }],
      entry: { title: "Gate" },
    });
    expect(Object.hasOwn(value.characters[0]!, "description")).toBe(true);
    expect(isJsonValue(value)).toBe(false);
    expect(() => assertJsonValue(value)).toThrow();
  });
  it.each([
    undefined,
    [undefined],
    { value: BigInt(1) },
    { value: Infinity },
    { value: () => 1 },
    { value: Symbol("x") },
  ])("keeps unsupported audit values diagnostic", (value) => {
    expect(toJsonValueOrDiagnostic(value)).toEqual(
      expect.stringContaining("non-serialisable"),
    );
  });
  it("still rejects cycles and safely copies prototype-named data keys", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(toJsonValueOrDiagnostic(cyclic)).toContain("circular");
    const value = JSON.parse('{"__proto__":{"safe":true}}');
    expect(toJsonValueOrDiagnostic(value)).toEqual(value);
    expect(Object.getPrototypeOf(toJsonValueOrDiagnostic(value))).toBe(
      Object.prototype,
    );
  });
});
