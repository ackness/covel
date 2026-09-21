import { describe, expect, it } from "vitest";
import handler from "../runtimes/creation/handler.js";

const mistportSchema = {
  version: 1,
  attributes: [
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
  ],
};

const dialogueSchema = {
  version: 1,
  attributes: [
    {
      id: "persona",
      name: { "zh-CN": "性格", "en-US": "Personality" },
      type: "string",
      category: "bio",
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

function makeCtx({
  phase = "setup",
  sessionId = "session-1",
  storeShape = "trusted",
  characters = [],
  playerInputs = [],
  inputs = {},
  pluginData = new Map(),
  worldSchema = mistportSchema,
}) {
  const sessionRecord = { id: sessionId, phase };
  const calls = { tools: [], forms: [], updates: [] };
  const ctx = {
    sessionId,
    turnId: "turn-1",
    pluginId: "tabletop-rules",
    locale: "en-US",
    // Builtin installs get the full DataStore surface: getSession(id) and
    // listPlayerInputs(id) both REQUIRE the session id. Community installs
    // get the session-bound view whose methods take no arguments.
    store:
      storeShape === "trusted"
        ? {
            getSession: async (id) => (id === sessionId ? sessionRecord : null),
            listPlayerInputs: async (id) =>
              id === sessionId ? playerInputs : [],
          }
        : {
            getSession: async () => sessionRecord,
            listPlayerInputs: async () => playerInputs,
          },
    pluginData: {
      get: async (namespace, key) =>
        pluginData.get(`${namespace}/${key}`) ?? null,
      set: async (namespace, key, value) => {
        pluginData.set(`${namespace}/${key}`, value);
      },
    },
    tools: {
      call: async (name, args) => {
        calls.tools.push({ name, args });
        if (name === "list-characters") return { characters };
        if (name === "get-character-schema") return { schema: worldSchema };
        if (name === "create-form") {
          calls.forms.push(args);
          return { interaction: { type: "form", interactionId: args.formId } };
        }
        if (name === "update-character") {
          calls.updates.push(args);
          return { success: true, characterId: args.id, version: 2 };
        }
        throw new Error(`unexpected tool: ${name}`);
      },
    },
    inputs,
  };
  return { ctx, calls, pluginData };
}

describe("creation handler", () => {
  it("waits for the character creator while the session is opening (trusted full-store shape)", async () => {
    const { ctx, calls, pluginData } = makeCtx({
      phase: "setup",
      characters: [],
    });
    const result = await handler(ctx);
    // The regression: getSession() without the session id returns null on the
    // full DataStore surface, which used to settle this runtime as done.
    expect(result).toEqual({
      outcome: "success",
      completion: "pending",
      value: {},
    });
    expect(calls.forms).toEqual([]);
    // Rules still derive and freeze during the wait, so the check runtime
    // (and the world-import flow without any creator) sees them from the
    // first turn.
    expect(pluginData.get("setup/rules")).toEqual(rules);
  });

  it("waits for the character creator while the session is opening (community session-bound shape)", async () => {
    const { ctx, calls } = makeCtx({
      phase: "setup",
      characters: [],
      storeShape: "community",
    });
    const result = await handler(ctx);
    expect(result.completion).toBe("pending");
    expect(calls.forms).toEqual([]);
  });

  it("derives rules from the same-turn world-data provider output without the schema read tool", async () => {
    const { ctx, calls, pluginData } = makeCtx({
      phase: "setup",
      characters: [],
      inputs: { schema: { cardinality: "one", value: mistportSchema } },
    });
    const result = await handler(ctx);
    expect(result.completion).toBe("pending");
    expect(pluginData.get("setup/rules")).toEqual(rules);
    expect(
      calls.tools.filter((call) => call.name === "get-character-schema"),
    ).toEqual([]);
  });

  it("settles silently when no player exists and the game is already running", async () => {
    const { ctx, calls, pluginData } = makeCtx({
      phase: "playing",
      characters: [],
    });
    const result = await handler(ctx);
    expect(result.completion).toBe("done");
    expect(result.value).toEqual({});
    expect(calls.forms).toEqual([]);
    // A late enable without a player still initializes the check rules.
    expect(pluginData.get("setup/rules")).toEqual(rules);
  });

  it("offers the allocation form on the turn the creator reports its player", async () => {
    const { ctx, calls, pluginData } = makeCtx({
      phase: "setup",
      characters: [],
      inputs: {
        playerId: { cardinality: "one", value: "char-player-1" },
      },
    });
    const result = await handler(ctx);
    expect(result.completion).toBe("pending");
    expect(result.value).toMatchObject({
      playerId: "char-player-1",
      rules,
    });
    expect(result.effects?.interactions).toEqual([
      { type: "form", interactionId: "tabletop-rules-allocation" },
    ]);
    expect(calls.forms).toHaveLength(1);
    expect(calls.forms[0]).toMatchObject({
      formId: "tabletop-rules-allocation",
      validation: { name: "point-buy" },
    });
    expect(calls.forms[0].fields.map((field) => field.name)).toEqual([
      "tideReading",
      "combat",
    ]);
    expect(pluginData.get("setup/rules")).toEqual(rules);
    expect(pluginData.get("setup/offered")).toEqual({
      formId: "tabletop-rules-allocation",
    });
  });

  it("applies a submitted allocation onto the committed player exactly once", async () => {
    const submission = {
      id: "submission-1",
      formId: "tabletop-rules-allocation",
      turnId: "turn-1",
      values: { tideReading: 4, combat: 2 },
    };
    const { ctx, calls, pluginData } = makeCtx({
      phase: "setup",
      characters: [{ id: "char-player-1", type: "player", fields: {} }],
      playerInputs: [submission],
      pluginData: new Map([
        ["setup/rules", rules],
        ["setup/offered", { formId: "tabletop-rules-allocation" }],
      ]),
    });
    const result = await handler(ctx);
    expect(result.completion).toBe("done");
    expect(calls.updates).toEqual([
      { id: "char-player-1", fields: { tideReading: 4, combat: 2 } },
    ]);
    expect(pluginData.get("setup/allocated")).toEqual({
      submissionId: "submission-1",
    });

    // A retry after the commit settles without re-applying the patch.
    const retried = await handler(
      makeCtx({
        phase: "setup",
        characters: [{ id: "char-player-1", type: "player", fields: {} }],
        playerInputs: [submission],
        pluginData,
      }).ctx,
    );
    expect(retried.completion).toBe("done");
    expect(retried.value).toMatchObject({ playerId: "char-player-1", rules });
  });

  it("skips silently for worlds without allocatable attributes", async () => {
    const { ctx, calls } = makeCtx({
      phase: "setup",
      worldSchema: dialogueSchema,
      inputs: {
        playerId: { cardinality: "one", value: "char-player-1" },
      },
    });
    const result = await handler(ctx);
    expect(result).toEqual({
      outcome: "success",
      completion: "done",
      value: { playerId: "char-player-1" },
    });
    expect(calls.forms).toEqual([]);
  });
});
