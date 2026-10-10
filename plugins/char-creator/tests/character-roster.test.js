import { describe, expect, it } from "vitest";
import { tool, z } from "@covel/tools";
import register from "../server/index.js";

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

  it("marks characters past the budget for an on-demand read", () => {
    const big = { notes: "x".repeat(7000) };
    const [, fields] = segments([character("a", big), character("b", big)]);
    expect(lines(fields, "character-fields")).toEqual([
      `a: ${JSON.stringify(big)}`,
      "b: fieldsOmitted",
    ]);
  });
});
