// @vitest-environment node
import { describe, expect, it } from "vitest";
import { classifySuspensionInput } from "../suspension-input.js";

describe("classifySuspensionInput", () => {
  it("maps each schema shape to its control", () => {
    expect(classifySuspensionInput({ type: "boolean" })).toEqual({
      kind: "confirm",
    });
    expect(classifySuspensionInput({ type: "string" })).toEqual({
      kind: "text",
    });
    expect(
      classifySuspensionInput({ type: "string", enum: ["left", "right"] }),
    ).toEqual({ kind: "choice", options: ["left", "right"] });
    expect(
      classifySuspensionInput({
        oneOf: [{ const: "a" }, { const: "b", title: "B" }],
      }),
    ).toEqual({ kind: "choice", options: ["a", "b"] });
    expect(
      classifySuspensionInput({
        type: "object",
        properties: { name: { type: "string" }, age: { type: "integer" } },
        required: ["name"],
      }).kind,
    ).toBe("form");
  });

  it("falls back to raw data only when nothing is described", () => {
    expect(classifySuspensionInput(undefined)).toEqual({ kind: "advanced" });
    expect(classifySuspensionInput({})).toEqual({ kind: "advanced" });
    expect(classifySuspensionInput({ type: "object", properties: {} })).toEqual(
      { kind: "advanced" },
    );
  });
});
