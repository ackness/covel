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
});
