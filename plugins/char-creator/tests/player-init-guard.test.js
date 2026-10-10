import {
  getToolContent,
  getPendingProposals,
} from "@covel/plugin-handlers-utils";
import { describe, it, expect } from "vitest";

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
    store: {
      listPlayerInputs: async () =>
        values ? [{ formId: "char-creation", values }] : [],
    },
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
    expect(getToolContent(result)).toMatchObject({
      preGameDone: true,
      playerExists: true,
    });
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
  it("asks for the form again when the world refuses a submitted attribute", async () => {
    const values = { characterName: "Alex", systems: "self-taught" };
    expect(await guard(context(values))).toEqual({ skip: false });
    expect(values.systems).toBe("self-taught");
  });
  it("offers the form again when the stored name belongs to a character of the world", async () => {
    const npcs = [
      {
        id: "char-tomas-vale",
        name: "Tomas Vale",
        aliases: ["Tomas"],
        type: "npc",
      },
    ];
    // Proposing the player would be refused at commit on every attempt.
    for (const characterName of ["Tomas", " tomas  VALE "]) {
      const result = await guard(context({ characterName }, npcs));
      expect(result).toEqual({ skip: false });
      expect(getPendingProposals(result)).toEqual([]);
    }
    const free = await guard(context({ characterName: "Tom" }, npcs));
    expect(getPendingProposals(free)).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ name: "Tom", type: "player" }),
      }),
    ]);
  });
  it("creates the player without a default that fails its own attribute type", async () => {
    const ctx = context({ characterName: "Alex" });
    ctx.world.characterSchema = {
      ...schema,
      attributes: [
        ...schema.attributes,
        {
          id: "rank",
          name: "Rank",
          type: "enum",
          category: "bio",
          options: ["low", "high"],
          defaultValue: "middle",
        },
      ],
    };
    const result = await guard(ctx);
    expect(getToolContent(result)).toMatchObject({ preGameDone: true });
    expect(getPendingProposals(result)).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ fields: { systems: 2 } }),
      }),
    ]);
  });
  it("goes on without a schema once the player skipped the failed setup step", async () => {
    const ctx = context({ characterName: "Alex" });
    ctx.world.characterSchema = null;
    const setupRuntimes = {
      "world-init/schema-gen": { state: "blocked" },
      "char-creator/player-init": { state: "pending", lastError: "x" },
    };
    ctx.store.getSession = async () => ({ setupRuntimes });
    await expect(guard(ctx)).rejects.toThrow("Character schema is not ready");
    setupRuntimes["world-init/schema-gen"] = {
      state: "done",
      resolution: "waived",
    };
    const result = await guard(ctx);
    expect(getPendingProposals(result)).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ name: "Alex", fields: {} }),
      }),
    ]);
  });
  it("buffers a player with schema defaults and no plugin-data mirror", async () => {
    const result = await guard(
      context({ characterName: "Alex", background: "Explorer" }),
    );
    expect(getToolContent(result)).toMatchObject({
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
    expect(getToolContent(result)).toMatchObject({
      skip: true,
      playerId: "player",
    });
    expect(getPendingProposals(result)).toEqual([]);
  });
  it("continues to the opening form when no player input exists", async () => {
    expect(await guard(context(null))).toEqual({ skip: false });
  });
  it("ignores a submission of another plugin's form", async () => {
    const ctx = context(null);
    ctx.store.listPlayerInputs = async () => [
      { formId: "char-creation", values: { characterName: "Alex" } },
      { formId: "tabletop-sheet", values: { name: "Someone Else" } },
    ];
    const result = await guard(ctx);
    expect(getPendingProposals(result)).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ name: "Alex" }),
      }),
    ]);
    ctx.store.listPlayerInputs = async () => [
      { formId: "tabletop-sheet", values: { name: "Someone Else" } },
    ];
    expect(await guard(ctx)).toEqual({ skip: false });
  });
});
