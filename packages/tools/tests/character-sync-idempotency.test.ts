import { describe, expect, it, vi } from "vitest";
import {
  createCharacterTools,
  type CharacterStore,
} from "../src/builtin/character-tools.js";
import { getPendingProposals, getToolContent } from "../src/result.js";

const context = {
  sessionId: "session",
  turnId: "turn",
  pluginId: "fixture",
  runtimeId: "fixture/tracker",
};
const existing = {
  id: "existing",
  sessionId: "session",
  name: "Mira",
  type: "player",
  description: "Authored profile",
  fields: { hp: 10 },
  version: 1,
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
};

function fixture() {
  const store: CharacterStore = {
    listCharacters: async () => [existing],
    upsertCharacter: vi.fn(),
    setPluginData: vi.fn(),
  };
  const sync = createCharacterTools(store).find(
    (tool) => tool.name === "sync-characters",
  )!;
  return { store, sync };
}

describe("character batch idempotency", () => {
  it("keeps duplicate creates unchanged while retaining other writes", async () => {
    const { store, sync } = fixture();
    const result = await sync.execute(
      {
        creates: [
          { name: "New NPC", type: "npc" },
          {
            name: "Mira",
            type: "player",
            description: "Invented profile",
            fields: { hp: 999 },
          },
        ],
        updates: [{ id: "existing", fields: { hp: 9 } }],
      },
      context,
    );
    expect(getToolContent(result)).toMatchObject({
      success: true,
      created: [{ name: "New NPC" }],
      unchanged: [{ characterId: "existing" }],
      updated: [{ characterId: "existing", version: 2 }],
    });
    const proposals = getPendingProposals(result);
    expect(proposals).toHaveLength(2);
    expect(proposals?.[1].payload).toMatchObject({
      id: "existing",
      fields: { hp: 9 },
    });
    expect(proposals?.[1].payload).not.toHaveProperty("description");
    expect(store.upsertCharacter).not.toHaveBeenCalled();
  });

  it("deduplicates characters created earlier in the same batch", async () => {
    const { sync } = fixture();
    const result = await sync.execute(
      {
        creates: [
          { name: "New NPC", type: "npc" },
          { name: "New NPC", type: "npc" },
        ],
      },
      context,
    );
    expect(getPendingProposals(result)).toHaveLength(1);
    expect(getToolContent(result)).toMatchObject({
      created: [{ name: "New NPC" }],
      unchanged: [{ name: "New NPC" }],
    });
  });

  it("does not write a partial batch after a duplicate followed by an invalid update", async () => {
    const { sync, store } = fixture();
    await expect(
      sync.execute(
        {
          creates: [
            { name: "Mira", type: "player" },
            { name: "New NPC", type: "npc" },
          ],
          updates: [{ id: "missing", fields: { hp: 9 } }],
        },
        context,
      ),
    ).rejects.toThrow("not found");
    expect(store.upsertCharacter).not.toHaveBeenCalled();
    expect(store.setPluginData).not.toHaveBeenCalled();
  });
});
