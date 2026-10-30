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
  it("keeps characters, characterSchema and dimensions without tables", () => {
    const characters = [{ id: "player", name: "Aning", type: "player" }];
    const characterSchema = { fields: { age: { type: "number" } } };

    const enriched = enrichGameStateFromSnapshot({
      characters,
      characterSchema,
      dimensions: {},
      dimensionSettlements: [],
    });

    expect(enriched).toEqual({
      characters,
      characterSchema,
      dimensions: {},
      dimensionSettlements: [],
    });
    // characters arrives from the snapshot even though no character.upserted
    // SSE event fires on the direct-write character path.
    expect(enriched.characters).toBe(characters);
    expect(enriched).not.toHaveProperty("tables");
  });

  it("clears characterSchema when the authoritative snapshot has none", () => {
    const enriched = enrichGameStateFromSnapshot({
      characters: [],
    });

    expect(enriched).toEqual({
      characters: [],
      characterSchema: null,
      dimensions: {},
      dimensionSettlements: [],
    });
    expect(enriched.characterSchema).toBeNull();
  });

  it("defaults absent optional snapshot fields", () => {
    const characters = [{ id: "npc-1", name: "Watcher", type: "npc" }];

    const enriched = enrichGameStateFromSnapshot({ characters });

    expect(enriched).toEqual({
      characters,
      characterSchema: null,
      dimensions: {},
      dimensionSettlements: [],
    });
  });
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
