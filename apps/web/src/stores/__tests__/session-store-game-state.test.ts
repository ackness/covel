import { describe, expect, it } from "vitest";
import { mergeGameStateForReplacement } from "../session-store.js";

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
