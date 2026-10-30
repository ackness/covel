import { describe, it, expect } from "vitest";
import type { CharacterAttributeSchema } from "@covel/shared";
import {
  buildSessionCharacterWriteTools,
  buildFieldsZodFromSchema,
} from "../src/index.js";
import type { CharacterStore } from "../src/builtin/character-tools.js";

// Minimal stub — session jsonSchema generation doesn't touch the store.
const stubStore: CharacterStore = {
  upsertCharacter: async () => {},
  listCharacters: async () => [],
  getCharacterSchema: async () => null,
};

const sampleSchema: CharacterAttributeSchema = {
  version: 1,
  attributes: [
    {
      id: "hp",
      name: "生命值",
      type: "number",
      min: 0,
      max: 100,
      defaultValue: 100,
      category: "stats",
      description: "当前生命值",
    },
    {
      id: "powerTier",
      name: "境界",
      type: "enum",
      options: ["练气", "筑基", "金丹"],
      category: "stats",
    },
    {
      id: "skills",
      name: "技能",
      type: "array",
      itemType: "string",
      category: "abilities",
    },
    { id: "awakened", name: "觉醒", type: "boolean", category: "abilities" },
    {
      id: "equipment",
      name: "装备",
      type: "object",
      category: "equipment",
      subSchema: [
        { id: "weapon", name: "武器", type: "string", category: "equipment" },
        {
          id: "consumables",
          name: "丹药",
          type: "array",
          itemType: "string",
          category: "equipment",
        },
      ],
    },
    {
      id: "relationships",
      name: "人际",
      type: "map",
      valueType: "string",
      category: "social",
    },
  ],
};

describe("buildFieldsZodFromSchema", () => {
  it("returns null for an empty schema", () => {
    const empty: CharacterAttributeSchema = { version: 1, attributes: [] };
    expect(buildFieldsZodFromSchema(empty)).toBeNull();
  });

  it("produces a Zod object whose JSON schema lists each declared attribute", () => {
    const z = buildFieldsZodFromSchema(sampleSchema);
    expect(z).not.toBeNull();
    type Z4 = { toJSONSchema(): Record<string, unknown> };
    const json = (z as unknown as Z4).toJSONSchema();
    const props = json.properties as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual([
      "awakened",
      "equipment",
      "hp",
      "powerTier",
      "relationships",
      "skills",
    ]);
  });

  it("preserves number bounds, enum options, array item type, and nested object shape", () => {
    const z = buildFieldsZodFromSchema(sampleSchema)!;
    type Z4 = { toJSONSchema(): Record<string, unknown> };
    const json = (z as unknown as Z4).toJSONSchema();
    const props = json.properties as Record<string, Record<string, unknown>>;

    expect(props.hp).toMatchObject({
      type: "number",
      minimum: 0,
      maximum: 100,
    });
    expect(props.powerTier).toMatchObject({
      type: "string",
      enum: ["练气", "筑基", "金丹"],
    });
    expect(
      (props.skills as { type: string; items: { type: string } }).items.type,
    ).toBe("string");
    expect(props.awakened?.type).toBe("boolean");

    // Nested object: the equipment schema should expose `weapon` and `consumables`
    const equipment = props.equipment as {
      type: string;
      properties: Record<string, unknown>;
    };
    expect(equipment.type).toBe("object");
    expect(Object.keys(equipment.properties).sort()).toEqual([
      "consumables",
      "weapon",
    ]);

    // Map: free-key record with string values
    const relationships = props.relationships as { type: string };
    expect(relationships.type).toBe("object");
  });
});

describe("buildSessionCharacterWriteTools", () => {
  it("advertises session bounds, enums and nested constraints without world prose", () => {
    const tools = buildSessionCharacterWriteTools(stubStore, {
      ...sampleSchema,
      types: ["npc", "companion"],
    });
    for (const tool of tools) {
      expect(tool.description).toContain(
        '"hp":{"type":"number","min":0,"max":100}',
      );
      expect(tool.description).toContain('"options":["练气","筑基","金丹"]');
      expect(tool.description).toContain('"weapon":{"type":"string"}');
      expect(tool.description).not.toContain("当前生命值");
      expect(tool.description).not.toContain("defaultValue");
    }
    const otherTools = buildSessionCharacterWriteTools(stubStore, {
      version: 1,
      types: ["npc", "companion"],
      attributes: [
        {
          id: "trust",
          name: "Trust",
          type: "number",
          category: "social",
          min: -5,
          max: 5,
        },
      ],
    });
    expect(otherTools[0]!.description).toContain('"min":-5');
    expect(otherTools[0]!.description).not.toContain('"hp"');
  });

  it("keeps batch fields compact and the update schema path stable", () => {
    const tools = buildSessionCharacterWriteTools(stubStore, {
      ...sampleSchema,
      types: ["npc", "companion"],
    });
    expect(tools.map((tool) => tool.name)).toEqual(["sync-characters"]);
    const schema = tools[0]!.jsonSchema as {
      properties: Record<
        string,
        { items: { properties: Record<string, unknown> } }
      >;
    };
    for (const name of ["creates", "updates"])
      expect(schema.properties[name]!.items.properties.fields).toMatchObject({
        type: "object",
        additionalProperties: {},
      });
    expect(schema.properties.creates!.items.properties.type).toMatchObject({
      enum: ["player", "npc", "companion"],
    });
    expect(
      Object.keys(schema.properties.updates!.items.properties).sort(),
    ).toEqual(["aliases", "description", "fields", "id", "removeAliases"]);
  });
});

describe("i18n attribute labels", () => {
  // A world may ship bilingual labels; the compact LLM-facing field
  // description must flatten the name while omitting the long prose body.
  const i18nSchema: CharacterAttributeSchema = {
    version: 1,
    attributes: [
      {
        id: "faction",
        name: { "zh-CN": "门派", "en-US": "Faction" },
        type: "string",
        category: "social",
        description: { "zh-CN": "所属门派", "en-US": "Affiliated faction" },
      },
    ],
  };

  it("flattens the i18n name into a compact field description", () => {
    const z = buildFieldsZodFromSchema(i18nSchema)!;
    type Z4 = { toJSONSchema(): Record<string, unknown> };
    const json = (z as unknown as Z4).toJSONSchema();
    const props = json.properties as Record<string, Record<string, unknown>>;
    const desc = props.faction?.description as string;

    expect(desc).toContain("门派");
    expect(desc).toContain("[social]");
    expect(desc).not.toContain("所属门派");
    expect(desc).not.toContain("[object Object]");
  });
});
