import { describe, expect, it } from "vitest";
import {
  attributeDefinitionSchema,
  validateWorldManifest,
} from "../src/index.js";

describe("attributeDefinitionSchema", () => {
  it("accepts an attribute with an i18n name + description", () => {
    const res = attributeDefinitionSchema.safeParse({
      id: "club",
      name: { "zh-CN": "社团", "en-US": "Club" },
      type: "string",
      category: "social",
      description: { "zh-CN": "所属社团", "en-US": "Club membership" },
    });
    expect(res.success).toBe(true);
  });

  it("accepts a plain-string name (back-compat with derived schemas)", () => {
    const res = attributeDefinitionSchema.safeParse({
      id: "hp",
      name: "生命值",
      type: "number",
      category: "stats",
    });
    expect(res.success).toBe(true);
  });

  it("rejects an unknown category", () => {
    const res = attributeDefinitionSchema.safeParse({
      id: "x",
      name: "X",
      type: "string",
      category: "not-a-category",
    });
    expect(res.success).toBe(false);
  });

  it("supports recursive subSchema for object attributes", () => {
    const res = attributeDefinitionSchema.safeParse({
      id: "equipment",
      name: { "zh-CN": "装备", "en-US": "Equipment" },
      type: "object",
      category: "equipment",
      subSchema: [
        {
          id: "weapon",
          name: { "zh-CN": "武器" },
          type: "string",
          category: "equipment",
        },
      ],
    });
    expect(res.success).toBe(true);
  });
});

describe("worldManifestSchema characterAttributes", () => {
  const base = {
    schemaVersion: "1.0",
    id: "demo-world",
    name: "Demo",
    summary: "A demo world.",
    defaultLocale: "zh-CN",
  };

  it("accepts a manifest declaring characterAttributes with i18n labels", () => {
    const res = validateWorldManifest({
      ...base,
      characterAttributes: [
        {
          id: "affection",
          name: { "zh-CN": "好感度", "en-US": "Affection" },
          type: "number",
          min: 0,
          max: 100,
          defaultValue: 0,
          category: "social",
        },
      ],
    });
    expect(res.valid).toBe(true);
    const ca = (res.data as { characterAttributes?: unknown[] })
      .characterAttributes;
    expect(Array.isArray(ca) && ca.length).toBe(1);
  });

  it("rejects a malformed characterAttributes entry", () => {
    const res = validateWorldManifest({
      ...base,
      characterAttributes: [{ id: "broken", name: "X", category: "social" }], // missing `type`
    });
    expect(res.valid).toBe(false);
  });
});
