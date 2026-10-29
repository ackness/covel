import { describe, expect, it } from "vitest";
import {
  materializeWorldModel,
  validateWorldModel,
} from "../src/proposals/world-model.js";

describe("world model ownership", () => {
  it("detaches the base world and dimensions before exposing a materialized view", () => {
    const base = {
      characters: [],
      characterSchema: null,
      dimensions: {},
      worldRecord: {
        id: "world",
        name: "World",
        description: "Setting",
        createdAt: "2026-10-16",
        metadata: { nested: { title: "Original" } },
      },
    };
    const view = materializeWorldModel(base, [], "session");
    base.worldRecord.metadata.nested.title = "Changed";
    expect(view.worldRecord?.metadata).toEqual({
      nested: { title: "Original" },
    });
    expect(view.dimensions).toEqual({});
    expect(view.dimensions).not.toBe(base.dimensions);
    expect(view.characters).not.toBe(base.characters);
    expect(
      materializeWorldModel(
        { characters: [], characterSchema: null },
        [],
        "session",
      ).dimensions,
    ).toEqual({});
  });
});

describe("player characters", () => {
  const player = (id: string) => ({
    id,
    sessionId: "session",
    name: id,
    type: "player",
    version: 1,
    createdAt: "2026-10-29",
    updatedAt: "2026-10-29",
  });

  it("accepts several player characters", () => {
    expect(() =>
      validateWorldModel({
        characters: [player("Ada"), player("Lin")],
        characterSchema: null,
        dimensions: {},
      }),
    ).not.toThrow();
    const view = materializeWorldModel(
      { characters: [player("Ada")], characterSchema: null },
      [
        {
          id: "p",
          type: "character.upsert",
          source: { pluginId: "creator", runtimeId: "creator" },
          turnId: "t",
          sessionId: "session",
          payload: { id: "Lin", name: "Lin", type: "player" },
          timestamp: "2026-10-29",
        },
      ],
      "session",
    );
    expect(view.characters.map((character) => character.id)).toEqual([
      "Ada",
      "Lin",
    ]);
  });

  it("carries the seats through as given and never changes them", () => {
    const seats = [
      {
        id: "main",
        controller: "human" as const,
        role: "player" as const,
        characters: "auto" as const,
      },
    ];
    const view = materializeWorldModel(
      { characters: [], characterSchema: null, seats },
      [],
      "session",
    );
    expect(view.seats).toEqual(seats);
    expect(view.seats).not.toBe(seats);
    expect(
      materializeWorldModel({ characters: [], characterSchema: null }, [], "s")
        .seats,
    ).toEqual([]);
  });
});
