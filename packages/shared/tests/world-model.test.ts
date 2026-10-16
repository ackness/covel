import { describe, expect, it } from "vitest";
import { materializeWorldModel } from "../src/proposals/world-model.js";

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
