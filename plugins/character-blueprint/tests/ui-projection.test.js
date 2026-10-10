import { describe, expect, it } from "vitest";
import register from "../server/index.js";
let project;
register({
  provideExtension: (point, _id, { handler }) => {
    if (point === "ui.slot@1") project = handler;
  },
});
const ref = { id: "a".repeat(64), mime: "image/png", size: 1 };
describe("character visual projection", () => {
  it("retains pregame art and switches to the world character id once present", async () => {
    const ctx = {
      world: { characters: [] },
      pluginData: {
        list: async () => [{ value: { characterId: "npc-hero", avatar: ref } }],
      },
    };
    expect(await project({ previous: null }, ctx)).toEqual({
      characters: [{ characterId: "npc-hero", avatar: ref }],
    });
    ctx.world.characters.push({ id: "npc-hero", name: "Hero" });
    expect(await project({ previous: null }, ctx)).toEqual({
      characters: [
        { characterId: "npc-hero", displayName: "Hero", avatar: ref },
      ],
    });
  });
  it("matches a bare blueprint id to its npc- character only, never to another id ending the same way", async () => {
    const ctx = {
      world: {
        characters: [
          { id: "old-guard", name: "Old Guard" },
          { id: "npc-guard", name: "Guard" },
        ],
      },
      pluginData: {
        list: async () => [{ value: { characterId: "guard", avatar: ref } }],
      },
    };
    expect(await project({ previous: null }, ctx)).toEqual({
      characters: [
        { characterId: "npc-guard", displayName: "Guard", avatar: ref },
      ],
    });
    ctx.world.characters.pop();
    expect((await project({ previous: null }, ctx)).characters).toEqual([
      { characterId: "guard", avatar: ref },
    ]);
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
