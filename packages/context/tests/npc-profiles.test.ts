// @vitest-environment node
import { describe, expect, it } from "vitest";
import { renderNpcProfiles } from "../src/prompt-internals.js";

describe("characters.npcs", () => {
  it("lists each non-player character's description and fields by name", () => {
    expect(
      renderNpcProfiles([
        { id: "char-ren", name: "Ren", type: "player" },
        {
          id: "npc-tomas-reed",
          name: "Tomas Reed",
          type: "npc",
          description: "Chief technician.",
          fields: { trust: 2 },
        },
        { id: "npc-eli", name: "Eli", type: "npc" },
      ]),
    ).toBe('- Tomas Reed [npc] | Chief technician. | {"trust":2}\n- Eli [npc]');
  });

  it("names the characters past the budget instead of dropping them", () => {
    const long = (name: string) => ({
      name,
      type: "npc",
      description: "x".repeat(400),
      fields: { notes: "y".repeat(400) },
    });
    const rendered = renderNpcProfiles(
      Array.from({ length: 12 }, (_, index) => long(`NPC ${index}`)),
    );
    const lines = rendered.split("\n");
    expect(rendered.length).toBeLessThan(8200);
    expect(lines.at(-1)).toMatch(
      /^- \(profiles not shown: NPC \d+, .*NPC 11\)$/,
    );
  });
});
