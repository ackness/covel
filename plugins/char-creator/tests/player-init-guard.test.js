import { describe, it, expect } from "vitest";
import { getPendingProposals } from "@covel/tools";
import guard from "../runtimes/player-init/guard.js";

const schema = {
  version: 1,
  types: ["npc", "companion"],
  attributes: [
    {
      id: "systems",
      name: "Systems",
      type: "number",
      category: "abilities",
      min: 0,
      max: 5,
      defaultValue: 2,
    },
  ],
};
function context(values, characters = []) {
  return {
    sessionId: "session",
    turnId: "turn",
    pluginId: "char-creator",
    runtimeId: "char-creator/player-init",
    world: { characterSchema: schema, characters },
    store: { listPlayerInputs: async () => (values ? [{ values }] : []) },
  };
}

describe("player initialization World Model", () => {
  it.each([null, { characterName: "Alex" }])(
    "fails without a schema before producing a form or a player for input %j",
    async (values) => {
      const ctx = context(values);
      ctx.world.characterSchema = null;
      await expect(guard(ctx)).rejects.toThrow("Character schema is not ready");
    },
  );
  it("accepts the retained submission after schema recovery and applies defaults", async () => {
    const ctx = context({ characterName: "Alex" });
    ctx.world.characterSchema = null;
    await expect(guard(ctx)).rejects.toThrow("Character schema is not ready");
    ctx.world.characterSchema = schema;
    const result = await guard(ctx);
    expect(result).toMatchObject({ preGameDone: true, playerExists: true });
    expect(getPendingProposals(result)).toEqual([
      expect.objectContaining({
        type: "character.upsert",
        payload: expect.objectContaining({
          name: "Alex",
          fields: { systems: 2 },
        }),
      }),
    ]);
  });
  it("rejects an invalid submitted attribute without rewriting the submission", async () => {
    const values = { characterName: "Alex", systems: "self-taught" };
    await expect(guard(context(values))).rejects.toThrow(/systems/);
    expect(values.systems).toBe("self-taught");
  });
  it("buffers a player with schema defaults and no plugin-data mirror", async () => {
    const result = await guard(
      context({ characterName: "Alex", background: "Explorer" }),
    );
    expect(result).toMatchObject({
      skip: true,
      playerExists: true,
      preGameDone: true,
    });
    expect(getPendingProposals(result)).toEqual([
      expect.objectContaining({
        type: "character.upsert",
        payload: expect.objectContaining({
          name: "Alex",
          type: "player",
          fields: { systems: 2, background: "Explorer" },
        }),
      }),
    ]);
  });
  it("reuses the player already visible in the execution", async () => {
    const ctx = context(null, [{ id: "player", type: "player" }]);
    ctx.world.characterSchema = null;
    const result = await guard(ctx);
    expect(result).toMatchObject({ skip: true, playerId: "player" });
    expect(getPendingProposals(result)).toEqual([]);
  });
  it("continues to the opening form when no player input exists", async () => {
    expect(await guard(context(null))).toEqual({ skip: false });
  });
});
