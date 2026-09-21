import { describe, expect, it } from "vitest";
import { creationRules, validateAllocation } from "../lib/rules.js";

const mistportAbilities = [
  {
    id: "tideReading",
    name: { "zh-CN": "潮汐解读", "en-US": "Tide reading" },
    type: "number",
    min: 0,
    max: 5,
    defaultValue: 1,
    category: "abilities",
  },
  {
    id: "combat",
    name: { "zh-CN": "格斗", "en-US": "Combat" },
    type: "number",
    min: 0,
    max: 5,
    defaultValue: 1,
    category: "abilities",
  },
];

// Haruka Academy shape: bio strings plus numbers in social/stats categories —
// nothing the default rule may allocate onto.
const dialogueSchema = {
  attributes: [
    {
      id: "persona",
      name: { "zh-CN": "性格", "en-US": "Personality" },
      type: "string",
      category: "bio",
    },
    {
      id: "affection",
      name: { "zh-CN": "好感度", "en-US": "Affection" },
      type: "number",
      min: 0,
      max: 100,
      defaultValue: 0,
      category: "social",
    },
    {
      id: "pressure",
      name: { "zh-CN": "压力", "en-US": "Pressure" },
      type: "number",
      min: 0,
      max: 100,
      defaultValue: 0,
      category: "stats",
    },
  ],
};

const rules = {
  budget: 4,
  attributes: [
    { id: "tideReading", label: "Tide reading", base: 1, max: 5 },
    { id: "combat", label: "Combat", base: 1, max: 5 },
  ],
};

describe("creationRules", () => {
  it("derives rules from bounded integer abilities", () => {
    expect(
      creationRules({ attributes: mistportAbilities }, null, "en-US"),
    ).toEqual(rules);
  });

  it("returns null for worlds without allocatable attributes (silent skip)", () => {
    expect(creationRules(dialogueSchema, null, "en-US")).toBeNull();
    expect(creationRules(undefined, null, "en-US")).toBeNull();
  });

  it("still rejects world-authored rules that clash with the schema", () => {
    expect(() =>
      creationRules(
        { attributes: mistportAbilities },
        {
          ...rules,
          attributes: [{ id: "combat", label: "Combat", base: 1, max: 99 }],
        },
        "en-US",
      ),
    ).toThrow("world schema");
  });
});

describe("validateAllocation", () => {
  it("accepts allocation-only values without a character name", () => {
    expect(
      validateAllocation({ tideReading: 4, combat: 2 }, rules),
    ).toBeUndefined();
  });

  it("rejects misspent budgets and out-of-range values", () => {
    expect(validateAllocation({ tideReading: 4, combat: 4 }, rules)).toMatch(
      /exactly 4 points/,
    );
    expect(validateAllocation({ tideReading: 6, combat: 0 }, rules)).toMatch(
      /integer from 1 to 5/,
    );
  });
});
