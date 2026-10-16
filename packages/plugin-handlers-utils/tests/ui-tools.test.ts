import { describe, expect, it } from "vitest";
import { createFormTool } from "../src/ui-tools.js";

const form = (type: string, defaultValue: unknown) => ({
  formId: "typed",
  title: "Typed defaults",
  fields: [{ type, name: "value", label: "Value", defaultValue }],
  submitLabel: "Continue",
  narrativeTemplate: "{{value}}",
});

describe("create-form defaults", () => {
  it.each([
    ["number", "5"],
    ["checkbox", "true"],
    ["checkbox", "false"],
  ] as const)("rejects string defaults for %s fields", (type, value) => {
    expect(() =>
      createFormTool.parametersSchema.parse(form(type, value)),
    ).toThrow("defaultValue must be");
  });
  it.each([
    ["number", 0],
    ["number", 5],
    ["checkbox", false],
    ["checkbox", true],
    ["text", "5"],
  ] as const)("accepts a typed default for %s fields", (type, value) => {
    expect(
      createFormTool.parametersSchema.parse(form(type, value)).fields[0]
        ?.defaultValue,
    ).toBe(value);
  });
});
