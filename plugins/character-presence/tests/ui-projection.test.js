import { describe, expect, it } from "vitest";
import register from "../server/index.js";
let project;
register({
  provideExtension: (_point, _id, { handler }) => {
    project = handler;
  },
});
const ref = { id: "a".repeat(64), mime: "image/png", size: 1 };
describe("character visual projection", () => {
  it("retains pregame art and switches to exact world character ids once present", async () => {
    const ctx = {
      world: { characters: [] },
      pluginData: {
        list: async () => [{ value: { characterId: "npc-hero", avatar: ref } }],
      },
    };
    expect(await project({ previous: null }, ctx)).toEqual({
      characters: [{ characterId: "npc-hero", avatar: ref }],
    });
    ctx.world.characters.push({ id: "session-npc-hero", name: "Hero" });
    expect(await project({ previous: null }, ctx)).toEqual({
      characters: [
        { characterId: "session-npc-hero", displayName: "Hero", avatar: ref },
      ],
    });
  });
  it("does not match a different compound suffix and preserves earlier provider values", async () => {
    const previous = { characters: [{ characterId: "other", avatar: ref }] };
    const ctx = {
      world: { characters: [{ id: "session-npc-iron-meg", name: "Meg" }] },
      pluginData: {
        list: async () => [{ value: { characterId: "npc-meg", sprite: ref } }],
      },
    };
    expect(
      (await project({ previous }, ctx)).characters.map(
        (value) => value.characterId,
      ),
    ).toEqual(["other", "npc-meg"]);
  });
});
