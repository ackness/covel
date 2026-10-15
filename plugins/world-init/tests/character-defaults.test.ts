import { describe, expect, it } from "vitest";
import {
  getPendingProposals,
  getToolContent,
  mergeSchemaDefaults,
} from "@covel/plugin-handlers-utils";
import { tool, z } from "@covel/tools";
import initializeWorld from "../tools/initialize-world.js";
import guard from "../guard.js";

const categories = ["stats", "bio", "abilities", "equipment", "social"];
const filler = Array.from({ length: 15 }, (_, index) => ({
  id: `field${index}`,
  name: `Field ${index}`,
  type: "string",
  category: categories[index % categories.length],
}));
const identity = [
  {
    id: "name",
    name: "Name",
    type: "string",
    category: "bio",
    defaultValue: "Mara Vale",
  },
  {
    id: "role",
    name: "Role",
    type: "string",
    category: "bio",
    defaultValue: "Lighthouse keeper",
  },
  {
    id: "background",
    name: "Background",
    type: "string",
    category: "bio",
    defaultValue: "Mara has tended the lamp for thirty years.",
  },
  {
    id: "faction",
    name: "Faction",
    type: "enum",
    category: "bio",
    options: ["keepers", "traders"],
    defaultValue: "keepers",
  },
];
const ctx = {
  sessionId: "session",
  turnId: "turn",
  pluginId: "world-init",
  runtimeId: "world-init/schema-gen",
  world: {
    worldRecord: {},
    characterSchema: null,
    characters: [],
    dimensions: {},
  },
};

describe("generated character defaults", () => {
  it("starts biography fields empty and keeps unrelated mechanical defaults", async () => {
    const attributes = [
      ...filler,
      ...identity,
      {
        id: "hp",
        name: "Health",
        type: "number",
        category: "stats",
        defaultValue: 100,
      },
      {
        id: "ready",
        name: "Ready",
        type: "boolean",
        category: "stats",
        defaultValue: false,
      },
      {
        id: "equipment",
        name: "Equipment",
        type: "array",
        itemType: "string",
        category: "equipment",
        defaultValue: ["travel clothes"],
      },
    ];
    const original = structuredClone(attributes);
    const result = await initializeWorld({ tool, z }).execute(
      { attributes },
      ctx,
    );
    const schema = getToolContent(result).worldSchema;
    expect(schema.attributes.slice(15, 18).map((a) => a.defaultValue)).toEqual([
      "",
      "",
      "",
    ]);
    expect(
      schema.attributes.find((a) => a.id === "faction"),
    ).not.toHaveProperty("defaultValue");
    expect(mergeSchemaDefaults({}, schema)).toEqual({
      name: "",
      role: "",
      background: "",
      hp: 100,
      ready: false,
      equipment: ["travel clothes"],
    });
    // NPCs supply their own identity; the shared defaults must not overwrite it.
    expect(
      mergeSchemaDefaults({ name: "Edda", role: "Trader" }, schema),
    ).toMatchObject({ name: "Edda", role: "Trader", hp: 100 });
    expect(getPendingProposals(result)[0]).toMatchObject({
      type: "character.schema.set",
      payload: schema,
    });
    expect(attributes).toEqual(original);
  });

  it("clears compound biography defaults and nested identities without inventing missing defaults", async () => {
    const result = await initializeWorld({ tool, z }).execute(
      {
        attributes: [
          ...filler,
          {
            id: "aliases",
            name: "Aliases",
            type: "array",
            itemType: "string",
            category: "bio",
            defaultValue: ["Mara"],
          },
          {
            id: "titles",
            name: "Titles",
            type: "map",
            category: "bio",
            defaultValue: { harbor: "Keeper" },
          },
          {
            id: "profile",
            name: "Profile",
            type: "object",
            category: "bio",
            defaultValue: { name: "Mara" },
            subSchema: [identity[0]],
          },
        ],
      },
      ctx,
    );
    const schema = getToolContent(result).worldSchema;
    expect(mergeSchemaDefaults({}, schema)).toEqual({
      aliases: [],
      titles: {},
      profile: {},
    });
    expect(
      schema.attributes.find((a) => a.id === "profile").subSchema[0]
        .defaultValue,
    ).toBe("");
    expect(schema.attributes[1]).not.toHaveProperty("defaultValue");
  });

  it("preserves authored biography defaults on the guard path", async () => {
    const authored = { types: ["npc"], attributes: identity };
    const result = await guard({
      ...ctx,
      world: {
        ...ctx.world,
        worldRecord: { metadata: { characterSchema: authored } },
      },
    });
    expect(getToolContent(result).worldSchema).toEqual(authored);
    expect(getPendingProposals(result)[0]).toMatchObject({
      type: "character.schema.set",
      payload: authored,
    });
  });

  it("rejects malformed attributes before returning any schema proposals", async () => {
    await expect(
      initializeWorld({ tool, z }).execute(
        { attributes: [...filler, { ...identity[0], type: "character" }] },
        ctx,
      ),
    ).rejects.toThrow();
  });
});
