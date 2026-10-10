import { describe, expect, it } from "vitest";
import { tool, z } from "@covel/tools";
import { estimateTokens } from "@covel/plugin-handlers-utils";
import register, { ROSTER_TOKEN_BUDGET } from "../server/index.js";

function rosterHandler() {
  let handler;
  register({
    toolkit: { tool, z },
    provideExtension: (_point, id, extension) => {
      if (id === "character-roster") handler = extension.handler;
    },
    registerTool: () => {},
    registerFormValidator: () => {},
    on: () => {},
  });
  return handler;
}

function character(id, fields) {
  return { id, name: id, type: "npc", version: 1, description: "", fields };
}

const lines = (segment, tag) =>
  segment.content
    .replace(new RegExp(`</?${tag}>`, "g"), "")
    .trim()
    .split("\n");

describe("character roster segments", () => {
  const segments = (characters) =>
    rosterHandler()({}, { world: { characters } });

  it("carries current fields so the tracker can settle without a read", () => {
    const [roster, fields] = segments([
      character("meg", { injury: "left hand eaten by fog" }),
      character("su-yao", {}),
    ]);
    expect(JSON.parse(lines(roster, "existing-characters")[0])).toEqual([
      { id: "meg", name: "meg", type: "npc", description: "" },
      { id: "su-yao", name: "su-yao", type: "npc", description: "" },
    ]);
    expect(lines(fields, "character-fields")).toEqual([
      'meg: {"injury":"left hand eaten by fog"}',
      "su-yao: {}",
    ]);
  });

  // The roster joins the part of the prompt that repeats from turn to turn,
  // so a value that changes with play must not be in it.
  it("keeps the roster unchanged when a sheet changes", () => {
    const before = segments([character("meg", { hp: 9 })]);
    const after = segments([{ ...character("meg", { hp: 4 }), version: 2 }]);
    expect(before[0]).toMatchObject({
      id: "character-roster",
      volatility: "session",
    });
    expect(after[0]).toEqual(before[0]);
    expect(after[1]).toMatchObject({
      id: "character-fields",
      volatility: "turn",
    });
    expect(after[1].content).not.toEqual(before[1].content);
  });

  it("cuts descriptions for a large cast and keeps every id, name and alias", () => {
    const cast = (count, description) =>
      Array.from({ length: count }, (_, index) => ({
        ...character(`npc-${index}`, {}),
        aliases: [`alias-${index}`],
        description,
      }));
    const rows = (characters) =>
      JSON.parse(lines(segments(characters)[0], "existing-characters")[0]);
    const paragraph =
      "她在雾港的旧码头长大，说话很慢，从不提起失踪的哥哥。".repeat(8);

    // A small cast keeps whole descriptions.
    expect(rows(cast(5, paragraph))[4].description).toBe(paragraph);

    // A larger one keeps the start of each, the same length for every row.
    const shortened = rows(cast(40, paragraph));
    expect(new Set(shortened.map((row) => row.description))).toEqual(
      new Set([`${paragraph.slice(0, 120)}...`]),
    );

    // A cast of two hundred is still named in full, without descriptions.
    const named = rows(cast(200, paragraph));
    expect(named).toHaveLength(200);
    expect(named[199]).toEqual({
      id: "npc-199",
      name: "npc-199",
      aliases: ["alias-199"],
      type: "npc",
    });
    expect(
      estimateTokens(segments(cast(100, paragraph))[0].content),
    ).toBeLessThanOrEqual(ROSTER_TOKEN_BUDGET + 20);
  });

  it("marks characters past the budget for an on-demand read", () => {
    const big = { notes: "x".repeat(7000) };
    const [, fields] = segments([character("a", big), character("b", big)]);
    expect(lines(fields, "character-fields")).toEqual([
      `a: ${JSON.stringify(big)}`,
      "b: fieldsOmitted",
    ]);
  });
});
