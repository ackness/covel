import { describe, it, expect, vi } from "vitest";
import guard from "../runtimes/player-init/guard.js";

function createStore() {
  const characters = [];
  const pluginData = [];
  const playerInputs = [];

  return {
    characters,
    pluginData,
    playerInputs,
    listCharacters: vi.fn(async (sessionId) =>
      characters.filter((character) => character.sessionId === sessionId),
    ),
    listPlayerInputs: vi.fn(async (sessionId) =>
      playerInputs.filter((input) => input.sessionId === sessionId),
    ),
    upsertCharacter: vi.fn(async (record) => {
      const index = characters.findIndex(
        (character) => character.id === record.id,
      );
      if (index >= 0) characters[index] = record;
      else characters.push(record);
    }),
    setPluginData: vi.fn(async (record) => {
      const index = pluginData.findIndex(
        (row) =>
          row.sessionId === record.sessionId &&
          row.pluginId === record.pluginId &&
          row.namespace === record.namespace &&
          row.key === record.key,
      );
      if (index >= 0) pluginData[index] = record;
      else pluginData.push(record);
    }),
  };
}

describe("char-creator/player-init guard character mirror", () => {
  it("creates a submitted player and mirrors it for the character panel", async () => {
    const store = createStore();
    store.playerInputs.push({
      id: "input-1",
      sessionId: "sess-1",
      values: {
        characterName: "柳无痕",
        background: "外门弟子，灵识敏锐",
        hp: 100,
        sect: "青萍宗",
      },
    });

    const result = await guard({ sessionId: "sess-1", store });

    expect(result).toMatchObject({
      skip: true,
      playerExists: true,
      playerName: "柳无痕",
      preGameDone: true,
    });
    expect(store.characters).toHaveLength(1);
    const character = store.characters[0];
    expect(character).toMatchObject({
      sessionId: "sess-1",
      name: "柳无痕",
      type: "player",
      description: "外门弟子，灵识敏锐",
      fields: { hp: 100, sect: "青萍宗" },
      version: 1,
    });
    expect(store.pluginData).toHaveLength(1);
    expect(store.pluginData[0]).toMatchObject({
      id: `char-mirror-${character.id}`,
      sessionId: "sess-1",
      pluginId: "char-creator",
      namespace: "characters",
      key: character.id,
    });
    expect(store.pluginData[0].value).toMatchObject({
      id: character.id,
      name: "柳无痕",
      type: "player",
      description: "外门弟子，灵识敏锐",
      fields: { hp: 100, sect: "青萍宗" },
      version: 1,
    });
  });

  it("mirrors an existing player while keeping one character row", async () => {
    const store = createStore();
    store.characters.push({
      id: "char-existing",
      sessionId: "sess-1",
      name: "赵铁山",
      type: "player",
      description: "体修弟子",
      fields: { hp: 120 },
      version: 1,
      createdAt: "2026-04-25T00:00:00.000Z",
      updatedAt: "2026-04-25T00:00:00.000Z",
    });

    const result = await guard({ sessionId: "sess-1", store });

    expect(result).toMatchObject({
      skip: true,
      playerExists: true,
      playerId: "char-existing",
      preGameDone: true,
    });
    expect(store.characters).toHaveLength(1);
    expect(store.upsertCharacter).toHaveBeenCalledTimes(0);
    expect(store.pluginData).toHaveLength(1);
    expect(store.pluginData[0]).toMatchObject({
      id: "char-mirror-char-existing",
      sessionId: "sess-1",
      pluginId: "char-creator",
      namespace: "characters",
      key: "char-existing",
    });
    expect(store.pluginData[0].value).toMatchObject({
      id: "char-existing",
      name: "赵铁山",
      type: "player",
      fields: { hp: 120 },
    });
  });

  it("repeated guard runs keep one player mirror row", async () => {
    const store = createStore();
    store.playerInputs.push({
      id: "input-1",
      sessionId: "sess-1",
      values: {
        name: "苏婉",
        bio: "剑修弟子",
        realm: "练气",
      },
    });

    await guard({ sessionId: "sess-1", store });
    await guard({ sessionId: "sess-1", store });

    expect(store.characters).toHaveLength(1);
    expect(store.pluginData).toHaveLength(1);
    expect(store.pluginData[0].key).toBe(store.characters[0].id);
    expect(store.pluginData[0].value).toMatchObject({
      id: store.characters[0].id,
      name: "苏婉",
      type: "player",
      description: "剑修弟子",
      fields: { realm: "练气" },
    });
  });
});
