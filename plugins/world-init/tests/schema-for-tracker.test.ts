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
});
