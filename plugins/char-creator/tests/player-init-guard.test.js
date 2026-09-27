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
    const result = await guard(
      context(null, [{ id: "player", type: "player" }]),
    );
    expect(result).toMatchObject({ skip: true, playerId: "player" });
    expect(getPendingProposals(result)).toEqual([]);
  });
  it("continues to the opening form when no player input exists", async () => {
    expect(await guard(context(null))).toEqual({ skip: false });
  });
});
