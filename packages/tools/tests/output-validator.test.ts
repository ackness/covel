import { describe, it, expect } from "vitest";
import { validateOutput } from "../src/output-validator.js";

describe("validateOutput", () => {
  it("should return valid for output matching schema", () => {
    const schema = {
      type: "object",
      properties: {
        title: { type: "string" },
      },
      required: ["title"],
    };
    const output = { title: "Hello" };

    const result = validateOutput(output, schema);

    expect(result).toEqual({ valid: true });
  });

  it("should return invalid when required field is missing", () => {
    const schema = {
      type: "object",
      properties: {
        title: { type: "string" },
      },
      required: ["title"],
    };
    const output = {};

    const result = validateOutput(output, schema);

    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
  });

  it("should return invalid when type is wrong", () => {
    const schema = {
      type: "object",
      properties: {
        count: { type: "number" },
      },
      required: ["count"],
    };
    const output = { count: "not-a-number" };

    const result = validateOutput(output, schema);

    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
  });

  it("should validate complex nested schema correctly", () => {
    const schema = {
      type: "object",
      properties: {
        user: {
          type: "object",
          properties: {
            name: { type: "string" },
            age: { type: "number" },
          },
          required: ["name", "age"],
        },
      },
      required: ["user"],
    };

    const validOutput = { user: { name: "Alice", age: 30 } };
    expect(validateOutput(validOutput, schema)).toEqual({ valid: true });

    const invalidOutput = { user: { name: "Alice" } };
    const result = validateOutput(invalidOutput, schema);
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
  });

  it("should accept any object for empty object schema", () => {
    const schema = { type: "object" };
    const output = { anything: "goes", nested: { value: 42 } };

    const result = validateOutput(output, schema);

    expect(result).toEqual({ valid: true });
  });

  it("should return invalid for null output", () => {
    const schema = { type: "object" };

    const result = validateOutput(null, schema);

    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
  });
});
