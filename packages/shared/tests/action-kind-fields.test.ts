import { describe, expect, it } from "vitest";
import { composerFieldsOf } from "../src/index.js";

const object = (properties: Record<string, unknown>, extra = {}) => ({
  type: "object",
  properties,
  ...extra,
});

describe("composerFieldsOf", () => {
  it("reads each supported property type in schema order", () => {
    const fields = composerFieldsOf(
      object(
        {
          name: { type: "string", title: "Name", description: "Who" },
          notes: { type: "string", maxLength: 500 },
          mood: { type: "string", enum: ["calm", "angry"] },
          dice: { type: "integer", minimum: 1, maximum: 6 },
          weight: { type: "number" },
          secret: { type: "boolean" },
        },
        { required: ["name"], additionalProperties: false },
      ),
    );
    expect(fields).toEqual([
      {
        name: "name",
        label: "Name",
        description: "Who",
        required: true,
        control: "text",
      },
      { name: "notes", label: "notes", required: false, control: "textarea" },
      {
        name: "mood",
        label: "mood",
        required: false,
        control: "select",
        options: ["calm", "angry"],
      },
      {
        name: "dice",
        label: "dice",
        required: false,
        control: "number",
        integer: true,
        minimum: 1,
        maximum: 6,
      },
      {
        name: "weight",
        label: "weight",
        required: false,
        control: "number",
        integer: false,
      },
      { name: "secret", label: "secret", required: false, control: "checkbox" },
    ]);
  });

  it("treats an object without properties as no fields", () => {
    expect(composerFieldsOf({ type: "object" })).toEqual([]);
  });

  it.each([
    ["a root that is not an object", { type: "array" }],
    ["a nested object", object({ a: { type: "object", properties: {} } })],
    ["an array property", object({ a: { type: "array", items: {} } })],
    ["a oneOf property", object({ a: { oneOf: [{ type: "string" }] } })],
    ["a property without a type", object({ a: {} })],
    ["a numeric enum", object({ a: { type: "number", enum: [1, 2] } })],
    ["a non-string string enum", object({ a: { type: "string", enum: [1] } })],
    ["a root oneOf", { type: "object", oneOf: [] }],
    ["a required name that is not a property", object({}, { required: ["x"] })],
  ])("rejects %s", (_name, schema) => {
    expect(composerFieldsOf(schema)).toBeNull();
  });
});
