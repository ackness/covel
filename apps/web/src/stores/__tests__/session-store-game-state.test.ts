// @vitest-environment node
import { describe, expect, it } from "vitest";
import { initialState, reducer } from "../session-store/reducer.js";
import {
  enrichGameStateFromSnapshot,
  mergeGameStateForReplacement,
} from "../session-store.js";

describe("session-store gameState replacement", () => {
  it("preserves framework character data when incoming state omits it", () => {
    const characters = [
      {
        id: "player",
        name: "Aning",
        type: "player",
        description: "Player character",
      },
    ];
    const characterSchema = {
      fields: {
        age: { type: "number" },
      },
    };

    const next = mergeGameStateForReplacement(
      {
        characters,
        characterSchema,
        mood: "calm",
      },
      {
        location: "dock",
      },
    );

    expect(next).toEqual({
      location: "dock",
      characters,
      characterSchema,
    });
  });

  it("uses incoming character data when the replacement includes it", () => {
    const currentCharacters = [
      {
        id: "player",
        name: "Aning",
        type: "player",
      },
    ];
    const incomingCharacters = [
      {
        id: "npc-1",
        name: "Watcher",
        type: "npc",
      },
    ];
    const incomingSchema = {
      fields: {
        trust: { type: "number" },
      },
    };

    const next = mergeGameStateForReplacement(
      {
        characters: currentCharacters,
        characterSchema: { fields: {} },
      },
      {
        characters: incomingCharacters,
        characterSchema: incomingSchema,
      },
    );

    expect(next.characters).toBe(incomingCharacters);
    expect(next.characterSchema).toBe(incomingSchema);
  });
});

describe("enrichGameStateFromSnapshot", () => {
  it("merges gameState, characters, and characterSchema from a snapshot", () => {
    const characters = [{ id: "player", name: "Aning", type: "player" }];
    const characterSchema = { fields: { age: { type: "number" } } };

    const enriched = enrichGameStateFromSnapshot({
      gameState: { location: "dock", mood: "calm" },
      characters,
      characterSchema,
      dimensions: {},
      dimensionSettlements: [],
    });

    expect(enriched).toEqual({
      tables: { location: "dock", mood: "calm" },
      characters,
      characterSchema,
      dimensions: {},
      dimensionSettlements: [],
    });
    // characters arrives from the snapshot even though no character.upserted
    // SSE event fires on the direct-write character path.
    expect(enriched.characters).toBe(characters);
  });

  it("clears characterSchema when the authoritative snapshot has none", () => {
    const enriched = enrichGameStateFromSnapshot({
      gameState: { turn: 3 },
      characters: [],
    });

    expect(enriched).toEqual({
      tables: { turn: 3 },
      characters: [],
      characterSchema: null,
      dimensions: {},
      dimensionSettlements: [],
    });
    expect(enriched.characterSchema).toBeNull();
  });

  it("tolerates a missing gameState slice", () => {
    const characters = [{ id: "npc-1", name: "Watcher", type: "npc" }];

    const enriched = enrichGameStateFromSnapshot({ characters });

    expect(enriched).toEqual({
      tables: {},
      characters,
      characterSchema: null,
      dimensions: {},
      dimensionSettlements: [],
    });
  });
});

it.each(["RESET_SESSION", "RESET_TO_WORLD_SELECT"] as const)(
  "clears complete snapshot ownership on %s",
  (type) => {
    const observed = reducer(initialState, {
      type: "SET_GAME_STATE",
      state: {},
    });
    expect(observed.hasGameStateSnapshot).toBe(true);
    expect(reducer(observed, { type }).hasGameStateSnapshot).toBe(false);
  },
);

it("isolates every plugin table from framework fields in snapshots, live patches and cached history", () => {
  const tables = {
    dimensions: { hp: 5 },
    characterSchema: { bogus: true },
    characters: { custom: 1 },
    dimensionProviderPluginId: { custom: 2 },
    tables: { nested: 3 },
  };
  const snapshot = enrichGameStateFromSnapshot({
    gameState: tables,
    characters: [],
    characterSchema: null,
    dimensions: {},
  });
  const patch = {
    id: "collision",
    summary: "Plugin tables",
    packageName: "probe",
    data: tables,
  };
  for (const state of [
    reducer(initialState, { type: "SET_GAME_STATE", state: snapshot }),
    reducer(
      { ...initialState, gameState: snapshot },
      { type: "MERGE_INITIAL_STATE_PATCHES", patches: [patch] },
    ),
    reducer(
      {
        ...initialState,
        gameState: {
          characters: [],
          characterSchema: null,
          dimensions: {},
          dimensionSettlements: [],
        },
      },
      { type: "MERGE_INITIAL_STATE_PATCHES", patches: [patch] },
    ),
  ]) {
    expect(state.gameState).toEqual({
      tables,
      characters: [],
      characterSchema: null,
      dimensions: {},
      dimensionSettlements: [],
    });
  }
});

it("can receive a valid dimension commit after a malformed snapshot without throwing", () => {
  const state = reducer(
    {
      ...initialState,
      gameState: {
        dimensions: { hp: 5 },
        dimensionProviderPluginId: "provider",
      },
    },
    {
      type: "MERGE_COMMITTED_DIMENSIONS",
      payload: {
        providerPluginId: "provider",
        dimensions: {
          weather: {
            name: "Weather",
            schema: { type: "string" },
            value: "rain",
            version: 1,
          },
        },
      },
    },
  );
  expect(state.gameState.dimensions).toEqual({
    weather: {
      name: "Weather",
      schema: { type: "string" },
      value: "rain",
      version: 1,
    },
  });
});
