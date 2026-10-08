import { describe, expect, it, vi } from "vitest";
import type { Proposal, WorldModelView } from "@covel/shared";
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
    getCharacterSchema: async () => null,
  };
  const sync = createCharacterTools(store).find(
    (tool) => tool.name === "sync-characters",
  )!;
  return { store, sync };
}

function world(characters: WorldModelView["characters"]): WorldModelView {
  return { characters, characterSchema: null, dimensions: {} };
}

describe("character batch idempotency", () => {
  it("overlays only this batch onto the supplied world, without replaying outer writes", async () => {
    const { sync } = fixture();
    const outer = (version: number): Proposal => ({
      id: `outer-${version}`,
      type: "character.upsert",
      source: { pluginId: context.pluginId, runtimeId: context.runtimeId },
      sessionId: context.sessionId,
      turnId: context.turnId,
      timestamp: existing.updatedAt,
      payload: {
        id: existing.id,
        name: existing.name,
        type: existing.type,
        expectedVersion: version - 1,
        version,
        fields: { hp: version },
      },
    });
    const snapshot = world([{ ...existing, version: 3, fields: { hp: 3 } }]);
    const original = structuredClone(snapshot);
    const result = await sync.execute(
      {
        updates: [
          { id: existing.id, fields: { hp: 4 } },
          { id: existing.id, description: "New profile" },
        ],
      },
      {
        ...context,
        world: snapshot,
        upstreamProposals: [outer(2)],
        pendingProposals: [outer(3)],
      },
    );
    expect(
      getPendingProposals(result).map((proposal) => proposal.payload),
    ).toMatchObject([
      { expectedVersion: 3, version: 4, fields: { hp: 4 } },
      { expectedVersion: 4, version: 5, description: "New profile" },
    ]);
    expect(snapshot).toEqual(original);
  });
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

  it.each([false, true])(
    "deduplicates characters created earlier in the same batch (world: %s)",
    async (withWorld) => {
      const { sync } = fixture();
      const result = await sync.execute(
        {
          creates: [
            { name: "New NPC", type: "npc" },
            { name: "New NPC", type: "npc" },
          ],
        },
        { ...context, ...(withWorld ? { world: world([existing]) } : {}) },
      );
      expect(getPendingProposals(result)).toHaveLength(1);
      expect(getToolContent(result)).toMatchObject({
        created: [{ name: "New NPC" }],
        unchanged: [{ name: "New NPC" }],
      });
    },
  );

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
  });
});
