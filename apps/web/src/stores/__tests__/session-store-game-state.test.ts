import { describe, expect, it } from "vitest";
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
    });

    expect(enriched).toEqual({
      location: "dock",
      mood: "calm",
      characters,
      characterSchema,
    });
    // characters arrives from the snapshot even though no character.upserted
    // SSE event fires on the direct-write character path.
    expect(enriched.characters).toBe(characters);
  });

  it("omits characterSchema when the snapshot has none", () => {
    const enriched = enrichGameStateFromSnapshot({
      gameState: { turn: 3 },
      characters: [],
    });

    expect(enriched).toEqual({ turn: 3, characters: [] });
    expect("characterSchema" in enriched).toBe(false);
  });

  it("tolerates a missing gameState slice", () => {
    const characters = [{ id: "npc-1", name: "Watcher", type: "npc" }];

    const enriched = enrichGameStateFromSnapshot({ characters });

    expect(enriched).toEqual({ characters });
  });
});
