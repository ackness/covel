import { describe, expect, it } from "vitest";
import { schemaForTracker } from "../lib/schema-for-tracker.js";

describe("schemaForTracker", () => {
  it("lowers every text limit and nothing else", () => {
    const schema = {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: {
          note: { type: "string", maxLength: 200 },
          score: { type: "integer", maximum: 10 },
          deeds: {
            type: "array",
            maxItems: 10,
            items: { type: "string", maxLength: 121 },
          },
        },
        required: ["note"],
      },
    };
    expect(schemaForTracker(schema)).toEqual({
      type: "object",
      additionalProperties: {
        type: "object",
        properties: {
          note: { type: "string", maxLength: 160 },
          score: { type: "integer", maximum: 10 },
          deeds: {
            type: "array",
            maxItems: 10,
            items: { type: "string", maxLength: 96 },
          },
        },
        required: ["note"],
      },
    });
    // The schema that is checked is not the one that is shown.
    expect(schema.additionalProperties.properties.note.maxLength).toBe(200);
  });

  it("shows no limit below the shortest text the author allows", () => {
    expect(
      schemaForTracker({ type: "string", minLength: 4, maxLength: 4 }),
    ).toEqual({ type: "string", minLength: 4, maxLength: 4 });
    expect(
      schemaForTracker({ type: "string", minLength: 9, maxLength: 10 }),
    ).toEqual({ type: "string", minLength: 9, maxLength: 9 });
  });

  it("keeps the limit of a text with fixed values", () => {
    const fixed = { type: "string", enum: ["north", "south"], maxLength: 5 };
    expect(schemaForTracker(fixed)).toEqual(fixed);
    const constant = { type: "string", const: "north", maxLength: 5 };
    expect(schemaForTracker(constant)).toEqual(constant);
  });
});
