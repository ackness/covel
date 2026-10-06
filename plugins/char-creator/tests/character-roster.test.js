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
    on: () => {},
  });
  return handler;
}

function character(id, fields) {
  return { id, name: id, type: "npc", version: 1, description: "", fields };
}

describe("character roster segment", () => {
  it("carries current fields so the tracker can settle without a read", () => {
    const [segment] = rosterHandler()(
      {},
      {
        world: {
          characters: [
            character("meg", { injury: "left hand eaten by fog" }),
            character("su-yao", {}),
          ],
        },
      },
    );
    const rows = JSON.parse(
      segment.content.replace(/<\/?existing-characters>/g, ""),
    );
    expect(rows[0].fields).toEqual({ injury: "left hand eaten by fog" });
    expect(rows[1].fields).toEqual({});
    expect(rows[0]).not.toHaveProperty("version");
  });

  it("marks characters past the budget for an on-demand read", () => {
    const big = { notes: "x".repeat(7000) };
    const [segment] = rosterHandler()(
      {},
      { world: { characters: [character("a", big), character("b", big)] } },
    );
    const rows = JSON.parse(
      segment.content.replace(/<\/?existing-characters>/g, ""),
    );
    expect(rows[0].fields).toEqual(big);
    expect(rows[1]).toMatchObject({ id: "b", fieldsOmitted: true });
    expect(rows[1].fields).toBeUndefined();
  });
});
