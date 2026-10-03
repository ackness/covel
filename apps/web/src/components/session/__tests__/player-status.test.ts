// @vitest-environment node
import { describe, expect, it } from "vitest";
import { selectPlayerStatus } from "../player-status.js";

const schema = {
  attributes: [
    { id: "persona", name: "Persona", type: "string", category: "bio" },
    {
      id: "vitality",
      name: { "zh-CN": "体力", "en-US": "Vitality" },
      type: "number",
      min: 0,
      max: 100,
      defaultValue: 100,
      category: "stats",
    },
    {
      id: "stress",
      name: { "zh-CN": "压力", "en-US": "Stress" },
      type: "number",
      min: 0,
      max: 10,
      defaultValue: 0,
      category: "stats",
    },
    // Unbounded and non-stats numbers are not gauges.
    { id: "gold", name: "Gold", type: "number", category: "stats" },
    {
      id: "combat",
      name: "Combat",
      type: "number",
      min: 0,
      max: 5,
      category: "abilities",
    },
  ],
};

describe("selectPlayerStatus", () => {
  it("turns the player's bounded stats into gauges", () => {
    const status = selectPlayerStatus(
      {
        characters: [
          { id: "npc", name: "Su Yao", type: "npc", fields: { vitality: 3 } },
          {
            id: "pc",
            name: "Zhang San",
            type: "player",
            fields: { vitality: 70, gold: 12, combat: 2 },
          },
        ],
        characterSchema: schema,
      },
      "zh-CN",
    );
    expect(status).toEqual({
      name: "Zhang San",
      meters: [
        { id: "vitality", label: "体力", value: 70, min: 0, max: 100 },
        // No stored value yet: the schema default stands in.
        { id: "stress", label: "压力", value: 0, min: 0, max: 10 },
      ],
      // A stat without a range is still worth a glance, as a plain number.
      readouts: [{ id: "gold", label: "Gold", value: 12 }],
      items: [],
    });
  });

  it("lists what the player carries from the equipment string lists", () => {
    const equipment = [
      {
        id: "gear",
        name: "Gear",
        type: "array",
        itemType: "string",
        category: "equipment",
      },
      // A flag in the same category is not an item.
      { id: "permit", name: "Permit", type: "boolean", category: "equipment" },
      {
        id: "relics",
        name: "Relics",
        type: "array",
        itemType: "string",
        category: "equipment",
      },
      // A string list outside the category is not carried gear.
      { id: "titles", name: "Titles", type: "array", category: "social" },
    ];
    const status = selectPlayerStatus(
      {
        characters: [
          {
            id: "pc",
            name: "Zhang San",
            type: "player",
            fields: {
              gear: ["fog lamp", "  ", "rope"],
              permit: true,
              relics: ["tide shard", 7],
              titles: ["apprentice"],
            },
          },
        ],
        // No bounded stats at all: the items alone make a status.
        characterSchema: { attributes: equipment },
      },
      "en-US",
    );
    expect(status).toEqual({
      name: "Zhang San",
      meters: [],
      readouts: [],
      items: ["fog lamp", "rope", "tide shard"],
    });
  });

  it("clamps a stored value into the attribute's range", () => {
    const status = selectPlayerStatus(
      {
        characters: [{ id: "pc", type: "player", fields: { vitality: 140 } }],
        characterSchema: schema,
      },
      "en-US",
    );
    expect(status?.meters[0]).toMatchObject({ label: "Vitality", value: 100 });
  });

  it("yields nothing without a player, or with neither stats nor items", () => {
    expect(
      selectPlayerStatus({ characters: [], characterSchema: schema }, "en-US"),
    ).toBeNull();
    expect(
      selectPlayerStatus(
        {
          characters: [{ id: "pc", type: "player", fields: {} }],
          characterSchema: { attributes: [schema.attributes[0]] },
        },
        "en-US",
      ),
    ).toBeNull();
  });
});
