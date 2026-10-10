/** list-characters caps what one call returns and says how many it left out. */

import { describe, it, expect } from "vitest";
import { getToolContent } from "../src/result.js";
import { createCharacterTools } from "../src/builtin/character-tools.js";

function storeWith(count: number) {
  const characters = Array.from({ length: count }, (_, i) => ({
    id: `c${i}`,
    sessionId: "sess-1",
    name: `Person ${i}`,
    type: "npc",
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  }));
  return {
    getCharacterSchema: async () => null,
    listCharacters: async () => characters,
    upsertCharacter: async () => undefined,
    setPluginData: async () => undefined,
  };
}

async function list(count: number) {
  const tool = createCharacterTools(storeWith(count)).find(
    (t) => t.name === "list-characters",
  )!;
  const result = await tool.execute(
    {},
    {
      sessionId: "sess-1",
      turnId: "turn-1",
      pluginId: "p",
      runtimeId: "p/r",
      pendingProposals: [],
    },
  );
  return getToolContent(result) as {
    _text: string;
    count: number;
    characters: unknown[];
  };
}

describe("list-characters cap", () => {
  it("lists every character below the cap with no note", async () => {
    const out = await list(16);
    expect(out.characters).toHaveLength(16);
    expect(out._text).not.toContain("not listed");
  });

  it("returns the most recent 50 and reports the rest", async () => {
    const out = await list(120);
    expect(out.count).toBe(120);
    expect(out.characters).toHaveLength(50);
    expect(out._text.split("\n")).toHaveLength(1 + 50 + 1);
    expect(out._text).toContain("70 more not listed");
    expect(out._text).toContain("Person 119");
    expect(out._text).not.toContain("Person 0 ");
  });
});
