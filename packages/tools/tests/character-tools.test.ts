/**
 * Tests for builtin character management tools.
 *
 * DELIBERATE CHANGE (effects isolation / W3d): create-character and
 * update-character no longer write to the store during execution. They return
 * `character.upsert` proposals (via withPendingProposals); the Session Kernel
 * commit chain performs the actual character write + plugin-data mirror at the
 * end of the execution. Reads (list/get/dedup) overlay the proposals buffered
 * earlier in the same tool loop, so a runtime reads its own uncommitted writes.
 *
 * These tests therefore thread pending proposals across calls (like the real
 * agent tool loop) via the `Loop` harness, and only see store state after an
 * explicit `commit()` that mimics the commit handler.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { materializeCharacterUpsert, type Proposal } from "@covel/shared";
import { getPendingProposals, getToolContent } from "../src/result.js";
import { createCharacterTools } from "../src/builtin/character-tools.js";
import type { ToolModule, ToolExecutionContext } from "../src/types.js";

interface CharacterLike {
  id: string;
  sessionId: string;
  name: string;
  aliases?: readonly string[];
  type: string;
  description?: string;
  fields?: unknown;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface PluginDataLike {
  id: string;
  sessionId: string;
  pluginId: string;
  namespace: string;
  key: string;
  value: unknown;
  createdAt: string;
  updatedAt: string;
}

/** Minimal in-memory store that satisfies the character + plugin-data subset used by the tools. */
function createMockStore() {
  const characters: CharacterLike[] = [];
  const pluginData: PluginDataLike[] = [];

  return {
    characters,
    pluginData,
    getCharacterSchema: async () => null,
    async upsertCharacter(record: CharacterLike) {
      const idx = characters.findIndex((c) => c.id === record.id);
      if (idx >= 0) characters[idx] = record;
      else characters.push(record);
    },
    listCharacters(sessionId: string) {
      return Promise.resolve(
        characters.filter((c) => c.sessionId === sessionId),
      );
    },
    setPluginData(record: PluginDataLike) {
      const idx = pluginData.findIndex(
        (r) =>
          r.sessionId === record.sessionId &&
          r.pluginId === record.pluginId &&
          r.namespace === record.namespace &&
          r.key === record.key,
      );
      if (idx >= 0) pluginData[idx] = record;
      else pluginData.push(record);
    },
  };
}

type MockStore = ReturnType<typeof createMockStore>;

/**
 * Apply buffered `character.upsert` proposals to the mock store exactly like
 * the real commit handler.
 */
function commitCharacterProposals(
  store: MockStore,
  pending: readonly Proposal[],
): void {
  for (const p of pending) {
    if (p.type !== "character.upsert") continue;
    // The proposal's logical timestamp is the update time, so a sequence of
    // buffered writes keeps a deterministic order in tests (the real commit
    // handler stamps commit-time now; ordering among same-turn writes is a
    // deliberate don't-care under the proposal model).
    store.upsertCharacter(
      materializeCharacterUpsert(
        p.payload,
        store.characters.find((character) => character.id === p.payload.id),
        p.sessionId,
        p.timestamp,
      ),
    );
  }
}

/** Threads pending proposals across tool calls, like the agent tool loop. */
class Loop {
  pending: Proposal[] = [];
  constructor(
    private readonly tools: readonly ToolModule[],
    private readonly store: MockStore,
    private readonly defaultPlugin = "char-creator",
    private readonly sessionId = "sess-1",
  ) {}

  private ctx(pluginId: string): ToolExecutionContext {
    return {
      sessionId: this.sessionId,
      turnId: "turn-1",
      pluginId,
      runtimeId: `${pluginId}/runtime`,
      pendingProposals: this.pending,
    };
  }

  async call(
    name: string,
    params: Record<string, unknown>,
    pluginId = this.defaultPlugin,
  ): Promise<Record<string, unknown>> {
    const t = this.tools.find((m) => m.name === name);
    if (!t) throw new Error(`Tool not found: ${name}`);
    const result = await t.execute(params, this.ctx(pluginId));
    this.pending.push(...getPendingProposals(result));
    return getToolContent(result) as Record<string, unknown>;
  }

  /** Simulate finalizeExecution committing the buffered proposals. */
  commit(): void {
    commitCharacterProposals(this.store, this.pending);
    this.pending = [];
  }
}

describe("builtin character tools", () => {
  let store: MockStore;
  let tools: readonly ToolModule[];
  let loop: Loop;

  beforeEach(() => {
    store = createMockStore();
    tools = createCharacterTools(store);
    loop = new Loop(tools, store);
  });

  it("registers character read and write tools", () => {
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "create-character",
      "get-character",
      "get-character-schema",
      "list-characters",
      "sync-characters",
      "update-character",
    ]);
  });

  it("reads the current session schema and overlays pending schema changes", async () => {
    const pendingSchema = {
      types: ["npc", "companion"],
      attributes: [
        {
          id: "power",
          name: "Power",
          type: "number" as const,
          category: "stats" as const,
          max: 5,
          defaultValue: 3,
        },
      ],
    };
    loop.pending.push({
      id: "schema",
      sessionId: "sess-1",
      turnId: "turn-1",
      source: { pluginId: "world-init", runtimeId: "schema" },
      timestamp: "2026-08-25T00:00:00.000Z",
      type: "character.schema.set",
      payload: pendingSchema,
    });
    expect(await loop.call("get-character-schema", {})).toMatchObject({
      schema: { ...pendingSchema, version: 1 },
    });
    const created = await loop.call("create-character", {
      name: "Alex",
      type: "player",
    });
    expect(loop.pending.at(-1)).toMatchObject({
      type: "character.upsert",
      payload: { fields: { power: 3 } },
    });
    await expect(
      loop.call("update-character", {
        id: created.characterId,
        fields: { power: 6 },
      }),
    ).rejects.toThrow(/power/);
    expect(store.characters).toEqual([]);
  });

  it("propagates schema storage failures before exposing a proposal", async () => {
    const caller = new Loop(
      createCharacterTools(
        Object.assign(store, {
          getCharacterSchema: async () => {
            throw new Error("schema store unavailable");
          },
        }),
      ),
      store,
    );
    await expect(
      caller.call("create-character", { name: "Alex", type: "player" }),
    ).rejects.toThrow("schema store unavailable");
    expect(caller.pending).toEqual([]);
  });

  it("ignores pending characters from a different session", async () => {
    await loop.call("create-character", { name: "Alex", type: "player" });
    loop.pending = loop.pending.map((p) => ({
      ...p,
      sessionId: "other-session",
    }));
    const created = await loop.call("create-character", {
      name: "Alex",
      type: "player",
    });
    expect(created).toMatchObject({ success: true, existed: false });
    expect(loop.pending).toHaveLength(2);
    expect(loop.pending[1]?.sessionId).toBe("sess-1");
  });

  it("rejects invalid create/update fields before exposing any proposal", async () => {
    const schemaStore = Object.assign(store, {
      getCharacterSchema: async () => ({
        sessionId: "sess-1",
        version: 1,
        types: ["npc", "companion"],
        attributes: [
          {
            id: "systems",
            name: "Systems",
            type: "number" as const,
            category: "abilities" as const,
            min: 0,
            max: 5,
            defaultValue: 2,
          },
        ],
        createdAt: "2026-09-05T00:00:00Z",
        updatedAt: "2026-09-05T00:00:00Z",
      }),
    });
    loop = new Loop(createCharacterTools(schemaStore), store);
    await expect(
      loop.call("create-character", {
        name: "Alex",
        type: "player",
        fields: { systems: "self-taught" },
      }),
    ).rejects.toThrow(/systems/);
    expect(loop.pending).toHaveLength(0);
    const created = await loop.call("create-character", {
      name: "Alex",
      type: "player",
    });
    loop.commit();
    await expect(
      loop.call("update-character", {
        id: created.characterId,
        fields: { systems: 6 },
      }),
    ).rejects.toThrow(/systems/);
    expect(loop.pending).toHaveLength(0);
    expect((await store.listCharacters("sess-1"))[0]?.fields).toEqual({
      systems: 2,
    });
  });

  describe("create-character", () => {
    it.each([false, true])(
      "preserves chained partial updates before commit (stored: %s)",
      async (stored) => {
        const created = await loop.call("create-character", {
          name: "Probe",
          type: "npc",
          description: "original",
          fields: { hp: 10, mp: 5 },
        });
        if (stored) loop.commit();
        await loop.call("update-character", {
          id: created.characterId,
          fields: { hp: 8 },
        });
        await loop.call("update-character", {
          id: created.characterId,
          fields: { mp: 4 },
        });
        await loop.call("update-character", {
          id: created.characterId,
          description: "",
        });
        const read = await loop.call("get-character", {
          id: created.characterId,
        });
        expect(read).toMatchObject({
          found: true,
          character: {
            name: "Probe",
            type: "npc",
            description: "",
            fields: { hp: 8, mp: 4 },
            version: 4,
          },
        });
        const snapshot = read.character as { fields: Record<string, unknown> };
        snapshot.fields.hp = -1;
        expect(
          await loop.call("get-character", { id: created.characterId }),
        ).toMatchObject({ character: { fields: { hp: 8, mp: 4 } } });
        loop.commit();
        expect(
          await loop.call("get-character", { id: created.characterId }),
        ).toMatchObject({
          character: { fields: { hp: 8, mp: 4 }, version: 4, description: "" },
        });
      },
    );

    it("emits a character.upsert proposal that persists on commit", async () => {
      const result = await loop.call("create-character", {
        name: "柳无痕",
        type: "player",
        description: "外门弟子，灵识敏锐",
        fields: { hp: 100, level: 1, lingGen: "水灵根" },
      });

      expect(getToolContent(result)).toMatchObject({
        success: true,
        characterId: expect.any(String),
        name: "柳无痕",
        type: "player",
      });
      // DELIBERATE CHANGE: nothing written during execution.
      expect(store.characters).toHaveLength(0);
      expect(loop.pending).toHaveLength(1);
      expect(loop.pending[0]!.type).toBe("character.upsert");

      loop.commit();
      expect(store.characters).toHaveLength(1);
      const char = store.characters[0];
      expect(char!.sessionId).toBe("sess-1");
      expect(char!.name).toBe("柳无痕");
      expect(char!.type).toBe("player");
      expect(char!.description).toBe("外门弟子，灵识敏锐");
      expect(char!.fields).toEqual({ hp: 100, level: 1, lingGen: "水灵根" });
      expect(char!.version).toBe(1);
    });

    it("validates type field and rejects invalid values", async () => {
      const t = tools.find((m) => m.name === "create-character")!;
      await expect(
        t.execute(
          { name: "X", type: "invalid" as never },
          {
            sessionId: "sess-1",
            turnId: "turn-1",
            pluginId: "char-creator",
            runtimeId: "char-creator/runtime",
          },
        ),
      ).rejects.toThrow();
    });

    it("requires a non-empty name", async () => {
      const t = tools.find((m) => m.name === "create-character")!;
      await expect(
        t.execute(
          { name: "", type: "player" },
          {
            sessionId: "sess-1",
            turnId: "turn-1",
            pluginId: "char-creator",
            runtimeId: "char-creator/runtime",
          },
        ),
      ).rejects.toThrow();
    });

    it("generates a unique id per call", async () => {
      const r1 = await loop.call("create-character", {
        name: "A",
        type: "npc",
      });
      const r2 = await loop.call("create-character", {
        name: "B",
        type: "npc",
      });
      expect((r1 as { characterId: string }).characterId).not.toBe(
        (r2 as { characterId: string }).characterId,
      );
      loop.commit();
      expect(store.characters).toHaveLength(2);
    });

    it("is idempotent for same (name, type) — sees buffered create, no duplicate", async () => {
      const r1 = await loop.call("create-character", {
        name: "赵铁山",
        type: "npc",
        description: "师叔",
        fields: { hp: 40 },
      });
      // Dedup must see the FIRST create even though it is only buffered.
      const r2 = await loop.call("create-character", {
        name: "赵铁山",
        type: "npc",
        description: "师叔 v2",
        fields: { hp: 45 },
      });
      const id1 = (r1 as { characterId: string }).characterId;
      const id2 = (r2 as { characterId: string }).characterId;
      expect(id2).toBe(id1);
      expect((r2 as { existed: boolean }).existed).toBe(true);
      // Only one upsert proposal was emitted (the dedup short-circuited).
      expect(loop.pending).toHaveLength(1);

      loop.commit();
      expect(store.characters.filter((c) => c.name === "赵铁山")).toHaveLength(
        1,
      );
    });

    it("allows different types with same name (player 与 npc 可以同名)", async () => {
      const r1 = await loop.call("create-character", {
        name: "Echo",
        type: "player",
      });
      const r2 = await loop.call("create-character", {
        name: "Echo",
        type: "npc",
      });
      expect((r1 as { characterId: string }).characterId).not.toBe(
        (r2 as { characterId: string }).characterId,
      );
      loop.commit();
      expect(store.characters).toHaveLength(2);
    });

    it("returns a human-readable _text summary (text-first convention)", async () => {
      const result = (await loop.call("create-character", {
        name: "柳无痕",
        type: "player",
        description: "外门弟子",
      })) as { _text: string; characterId: string };
      expect(typeof getToolContent(result)._text).toBe("string");
      expect(getToolContent(result)._text).toContain("柳无痕");
      expect(getToolContent(result)._text).toContain("player");
      expect(getToolContent(result)._text).toContain(
        getToolContent(result).characterId,
      );
    });

    it("_text reflects existed=true path when duplicate", async () => {
      await loop.call("create-character", { name: "孙师叔", type: "npc" });
      const r2 = (await loop.call("create-character", {
        name: "孙师叔",
        type: "npc",
      })) as { _text: string };
      expect(r2._text).toMatch(/already exists|已存在|existed/i);
    });
  });

  describe("update-character", () => {
    it("merges fields into buffered character and bumps version", async () => {
      const created = await loop.call("create-character", {
        name: "苏婉",
        type: "npc",
        fields: { hp: 100, status: "alive" },
      });
      const charId = (created as { characterId: string }).characterId;

      // update reads its own buffered create via the overlay.
      const result = await loop.call("update-character", {
        id: charId,
        fields: { hp: 50, status: "wounded", injuries: ["arm"] },
      });

      expect(getToolContent(result)).toMatchObject({
        success: true,
        characterId: charId,
        version: 2,
      });

      loop.commit();
      const char = store.characters.find((c) => c.id === charId)!;
      expect(char.fields).toEqual({
        hp: 50,
        status: "wounded",
        injuries: ["arm"],
      });
      expect(char.version).toBe(2);
    });

    it("updates description when provided", async () => {
      const created = await loop.call("create-character", {
        name: "柳娘",
        type: "npc",
        description: "药王谷谷主",
      });
      const charId = (created as { characterId: string }).characterId;

      await loop.call("update-character", {
        id: charId,
        description: "药王谷谷主，已故",
      });

      loop.commit();
      const char = store.characters.find((c) => c.id === charId)!;
      expect(char.description).toBe("药王谷谷主，已故");
    });

    it("rejects when the character id does not exist", async () => {
      await expect(
        loop.call("update-character", {
          id: "nonexistent",
          fields: { hp: 1 },
        }),
      ).rejects.toThrow('Character "nonexistent" not found');
      expect(loop.pending).toHaveLength(0);
    });
  });

  describe("sync-characters", () => {
    it("publishes bounded create and update arrays to the model", () => {
      const syncTool = tools.find((item) => item.name === "sync-characters")!;

      expect(syncTool.jsonSchema).toMatchObject({
        type: "object",
        properties: {
          creates: { type: "array", maxItems: 5 },
          updates: { type: "array", maxItems: 10 },
        },
      });
    });

    it("queues new and existing character changes in one call", async () => {
      const existing = await loop.call("create-character", {
        name: "苏婉",
        type: "npc",
        fields: { hp: 100 },
      });
      const existingId = (existing as { characterId: string }).characterId;
      loop.commit();

      const result = await loop.call("sync-characters", {
        creates: [
          {
            name: "林昭",
            type: "npc",
            description: "新到任的执事",
            fields: { status: "alert" },
          },
        ],
        updates: [{ id: existingId, fields: { hp: 75, status: "wounded" } }],
      });

      expect(getToolContent(result)).toMatchObject({
        success: true,
        created: [expect.objectContaining({ name: "林昭", type: "npc" })],
        updated: [expect.objectContaining({ characterId: existingId })],
      });
      expect(loop.pending).toHaveLength(2);
      expect(store.characters).toHaveLength(1);

      loop.commit();
      expect(store.characters).toHaveLength(2);
      expect(
        store.characters.find((item) => item.id === existingId)?.fields,
      ).toEqual({
        hp: 75,
        status: "wounded",
      });
    });

    it("does not expose earlier writes when a later update fails", async () => {
      await expect(
        loop.call("sync-characters", {
          creates: [{ name: "未提交角色", type: "npc" }],
          updates: [{ id: "char-missing", fields: { hp: 1 } }],
        }),
      ).rejects.toThrow("not found");

      expect(loop.pending).toHaveLength(0);
      expect(store.characters).toHaveLength(0);
    });

    it("settles an empty sync as no change", async () => {
      await expect(
        loop.call("sync-characters", { creates: [], updates: [] }),
      ).resolves.toMatchObject({ success: true, created: [], updated: [] });
      expect(loop.pending).toHaveLength(0);
    });
  });

  describe("list-characters", () => {
    beforeEach(async () => {
      // Seed via committed state so list has a store baseline to read.
      await loop.call("create-character", {
        name: "柳无痕",
        type: "player",
        description: "外门弟子",
      });
      await loop.call("create-character", {
        name: "苏婉",
        type: "npc",
        description: "师姐",
      });
      await loop.call("create-character", {
        name: "柳娘",
        type: "npc",
        description: "药王谷谷主",
      });
      loop.commit();
    });

    it("returns a text summary listing all session characters", async () => {
      const result = (await loop.call("list-characters", {})) as {
        _text: string;
        count: number;
      };
      expect(typeof getToolContent(result)._text).toBe("string");
      expect(getToolContent(result).count).toBe(3);
      expect(getToolContent(result)._text).toContain("柳无痕");
      expect(getToolContent(result)._text).toContain("苏婉");
      expect(getToolContent(result)._text).toContain("柳娘");
      expect(getToolContent(result)._text).toContain("外门弟子");
      expect(getToolContent(result)._text).toContain("player");
      expect(getToolContent(result)._text).toContain("npc");
    });

    it("filters by type when provided", async () => {
      const result = (await loop.call("list-characters", { type: "npc" })) as {
        _text: string;
        count: number;
      };
      expect(getToolContent(result).count).toBe(2);
      expect(getToolContent(result)._text).toContain("苏婉");
      expect(getToolContent(result)._text).toContain("柳娘");
      expect(getToolContent(result)._text).not.toContain("柳无痕");
    });

    it("handles empty session with a clear empty message", async () => {
      const emptyStore = createMockStore();
      const emptyLoop = new Loop(createCharacterTools(emptyStore), emptyStore);
      const result = (await emptyLoop.call("list-characters", {})) as {
        _text: string;
        count: number;
      };
      expect(getToolContent(result).count).toBe(0);
      expect(getToolContent(result)._text.toLowerCase()).toMatch(
        /no character|empty|没有|暂无/,
      );
    });

    it('treats "None" filter values as no filter', async () => {
      const result = (await loop.call("list-characters", {
        type: "None",
      })) as { _text: string; count: number };
      expect(getToolContent(result).count).toBe(3);
      expect(getToolContent(result)._text).toContain("柳无痕");
      expect(getToolContent(result)._text).toContain("苏婉");
      expect(getToolContent(result)._text).toContain("柳娘");
    });

    it("sorts by frequency (version) desc, then updatedAt desc", async () => {
      const suwan = (await loop.call("get-character", { name: "苏婉" })) as {
        _text: string;
      };
      const suwanId = /char-[a-f0-9-]+/.exec(suwan._text)?.[0];
      const liuniang = (await loop.call("get-character", { name: "柳娘" })) as {
        _text: string;
      };
      const liuniangId = /char-[a-f0-9-]+/.exec(liuniang._text)?.[0];

      expect(suwanId).toBeDefined();
      expect(liuniangId).toBeDefined();

      await loop.call("update-character", {
        id: suwanId!,
        fields: { hp: 90 },
      });
      await loop.call("update-character", {
        id: suwanId!,
        fields: { hp: 80 },
      });
      await loop.call("update-character", {
        id: liuniangId!,
        fields: { hp: 60 },
      });
      loop.commit();

      const list = (await loop.call("list-characters", {})) as {
        _text: string;
      };
      const suwanPos = list._text.indexOf("苏婉");
      const liuniangPos = list._text.indexOf("柳娘");
      const liuwuhenPos = list._text.indexOf("柳无痕");
      expect(suwanPos).toBeLessThan(liuniangPos);
      expect(liuniangPos).toBeLessThan(liuwuhenPos);
    });

    it("recency breaks frequency ties (same version → newer updatedAt first)", async () => {
      const freshStore = createMockStore();
      const freshLoop = new Loop(createCharacterTools(freshStore), freshStore);
      await freshLoop.call("create-character", {
        name: "柳无痕",
        type: "player",
      });
      await new Promise((r) => setTimeout(r, 5));
      await freshLoop.call("create-character", { name: "苏婉", type: "npc" });
      await new Promise((r) => setTimeout(r, 5));
      await freshLoop.call("create-character", { name: "柳娘", type: "npc" });
      freshLoop.commit();

      const list = (await freshLoop.call("list-characters", {})) as {
        _text: string;
      };
      const liuniangPos = list._text.indexOf("柳娘");
      const suwanPos = list._text.indexOf("苏婉");
      const liuwuhenPos = list._text.indexOf("柳无痕");
      expect(liuniangPos).toBeLessThan(suwanPos);
      expect(suwanPos).toBeLessThan(liuwuhenPos);
    });

    it("includes cross-plugin characters (session-scoped)", async () => {
      await loop.call(
        "create-character",
        { name: "NarratorGhost", type: "npc" },
        "narrator",
      );
      loop.commit();

      const result = (await loop.call("list-characters", {})) as {
        _text: string;
        count: number;
      };
      expect(getToolContent(result).count).toBe(4);
      expect(getToolContent(result)._text).toContain("NarratorGhost");
    });
  });

  describe("get-character", () => {
    let charId: string;

    beforeEach(async () => {
      const created = await loop.call("create-character", {
        name: "柳无痕",
        type: "player",
        fields: { hp: 100 },
      });
      charId = (created as { characterId: string }).characterId;
      loop.commit();
    });

    it("returns full character detail as text when found by id", async () => {
      const result = (await loop.call("get-character", { id: charId })) as {
        _text: string;
        found: boolean;
      };
      expect(getToolContent(result).found).toBe(true);
      expect(typeof getToolContent(result)._text).toBe("string");
      expect(getToolContent(result)._text).toContain("柳无痕");
      expect(getToolContent(result)._text).toContain("player");
      expect(getToolContent(result)._text).toContain(charId);
      expect(getToolContent(result)._text).toContain("hp");
      expect(getToolContent(result)._text).toContain("100");
    });

    it("looks up by name and returns full detail", async () => {
      const result = (await loop.call("get-character", { name: "柳无痕" })) as {
        _text: string;
        found: boolean;
      };
      expect(getToolContent(result).found).toBe(true);
      expect(getToolContent(result)._text).toContain("柳无痕");
      expect(getToolContent(result)._text).toContain("player");
    });

    it("resolves a partial name and lists candidates on a miss", async () => {
      await loop.call("create-character", {
        name: "Dr. Mina Park",
        type: "npc",
      });
      await loop.call("create-character", { name: "Mina Okafor", type: "npc" });
      loop.commit();
      const found = getToolContent(
        (await loop.call("get-character", { name: "mina park" })) as {
          _text: string;
        },
      );
      expect(found._text).toContain("Dr. Mina Park");

      const ambiguous = getToolContent(
        (await loop.call("get-character", { name: "Mina" })) as {
          found: boolean;
          candidates: string[];
        },
      );
      expect(ambiguous.found).toBe(false);
      expect(ambiguous.candidates).toEqual(["Dr. Mina Park", "Mina Okafor"]);

      const missing = getToolContent(
        (await loop.call("get-character", { name: "Eli" })) as {
          _text: string;
          candidates: string[];
        },
      );
      expect(missing._text).toContain("Characters in session:");
      expect(missing.candidates).toContain("柳无痕");
    });

    it("returns text saying not found when id is missing", async () => {
      const result = (await loop.call("get-character", { id: "nope" })) as {
        _text: string;
        found: boolean;
      };
      expect(getToolContent(result).found).toBe(false);
      expect(getToolContent(result)._text.toLowerCase()).toMatch(
        /not found|未找到|不存在/,
      );
    });

    it("requires either id or name", async () => {
      const t = tools.find((m) => m.name === "get-character")!;
      await expect(
        t.execute(
          {},
          {
            sessionId: "sess-1",
            turnId: "turn-1",
            pluginId: "char-creator",
            runtimeId: "char-creator/runtime",
          },
        ),
      ).rejects.toThrow();
    });

    it("reads a character that is only buffered (not yet committed)", async () => {
      const created = await loop.call("create-character", {
        name: "未落库者",
        type: "npc",
      });
      const bufferedId = (created as { characterId: string }).characterId;
      // Deliberately NOT committed — the overlay must still surface it.
      const result = (await loop.call("get-character", {
        id: bufferedId,
      })) as { _text: string; found: boolean };
      expect(getToolContent(result).found).toBe(true);
      expect(getToolContent(result)._text).toContain("未落库者");
    });
  });

  describe("aliases", () => {
    beforeEach(async () => {
      await loop.call("create-character", {
        name: "Isolde",
        aliases: ["the keeper", "伊索德", "isolde"],
        type: "npc",
        fields: { hp: 10 },
      });
      await loop.call("create-character", { name: "Corvin", type: "npc" });
      loop.commit();
    });
    const isolde = () => store.characters.find((c) => c.name === "Isolde")!;

    it("stores the aliases a character is created with, without its own name", () => {
      expect(isolde().aliases).toEqual(["the keeper", "伊索德"]);
    });

    it("updates the existing character when it is addressed by an alias, in another spelling", async () => {
      const result = await loop.call("update-character", {
        id: "The  Keeper",
        fields: { hp: 4 },
      });
      loop.commit();
      expect(result.characterId).toBe(isolde().id);
      expect(isolde().fields).toEqual({ hp: 4 });
      expect(store.characters).toHaveLength(2);
    });

    it("returns the existing character when a create names it by an alias, whatever the type", async () => {
      const result = await loop.call("create-character", {
        name: "伊索德",
        type: "companion",
      });
      loop.commit();
      expect(result).toMatchObject({
        existed: true,
        characterId: isolde().id,
      });
      expect(store.characters).toHaveLength(2);
    });

    it("adds an alias the story reveals and keeps the earlier ones", async () => {
      const result = await loop.call("update-character", {
        id: isolde().id,
        aliases: ["Keeper Ysolde", "THE KEEPER"],
      });
      loop.commit();
      expect(result._text).toContain("aliases: + Keeper Ysolde");
      expect(isolde().aliases).toEqual([
        "the keeper",
        "伊索德",
        "Keeper Ysolde",
      ]);
    });

    it("adds aliases from two updates of one execution", async () => {
      await loop.call("update-character", { id: "Isolde", aliases: ["Sol"] });
      await loop.call("update-character", { id: "Sol", aliases: ["Izzy"] });
      loop.commit();
      expect(isolde().aliases).toEqual(["the keeper", "伊索德", "Sol", "Izzy"]);
    });

    it("refuses an alias that is a name or alias of another character and names the owner", async () => {
      await expect(
        loop.call("update-character", {
          id: "Corvin",
          aliases: ["The Keeper"],
        }),
      ).rejects.toThrow(
        `"The Keeper" is already a name of Isolde (aka the keeper, 伊索德) [${isolde().id}]`,
      );
      await expect(
        loop.call("create-character", {
          name: "Old Woman",
          aliases: ["Isolde"],
          type: "npc",
        }),
      ).rejects.toThrow("is already a name of Isolde");
      expect(loop.pending).toEqual([]);
    });

    it("takes away an alias in any spelling, so another character can have the name", async () => {
      const result = await loop.call("update-character", {
        id: "Isolde",
        removeAliases: ["The  Keeper", "never an alias", "Isolde"],
      });
      expect(result._text).toContain("aliases: - the keeper");
      await loop.call("update-character", {
        id: "Corvin",
        aliases: ["the keeper"],
      });
      loop.commit();
      expect(isolde()).toMatchObject({ name: "Isolde", aliases: ["伊索德"] });
      expect(
        store.characters.find((c) => c.name === "Corvin")!.aliases,
      ).toEqual(["the keeper"]);
    });

    it("moves a wrong alias in one sync-characters call and drops the list with the last alias", async () => {
      await loop.call("sync-characters", {
        creates: [],
        updates: [
          { id: "Isolde", removeAliases: ["the keeper", "伊索德"] },
          { id: "Corvin", aliases: ["the keeper"] },
        ],
      });
      loop.commit();
      expect(isolde()).not.toHaveProperty("aliases");
      expect(
        store.characters.find((c) => c.name === "Corvin")!.aliases,
      ).toEqual(["the keeper"]);
    });

    it("replaces an alias in one update and tells how to free a wrong one", async () => {
      await loop.call("update-character", {
        id: "Isolde",
        removeAliases: ["the keeper"],
        aliases: ["the lamp keeper"],
      });
      loop.commit();
      expect(isolde().aliases).toEqual(["伊索德", "the lamp keeper"]);
      await expect(
        loop.call("update-character", { id: "Corvin", aliases: ["伊索德"] }),
      ).rejects.toThrow(
        `If the alias is wrong for Isolde, remove it there first: update ${isolde().id} with removeAliases.`,
      );
    });

    it("names the closest known characters when an update misses, and writes nothing", async () => {
      await expect(
        loop.call("update-character", { id: "Isolda", fields: { hp: 1 } }),
      ).rejects.toThrow(
        'Character "Isolda" not found. Closest known names: Isolde (aka the keeper, 伊索德).',
      );
      expect(loop.pending).toEqual([]);
    });

    it("does not let an update reach a character by a part of its name", async () => {
      await expect(
        loop.call("update-character", { id: "Isol", fields: { hp: 1 } }),
      ).rejects.toThrow("not found");
    });

    it("reports an alias that two stored characters share as ambiguous", async () => {
      store.characters.push({
        ...isolde(),
        id: "char-other",
        name: "Maud",
        aliases: ["the keeper"],
      });
      await expect(
        loop.call("update-character", { id: "the keeper", fields: { hp: 1 } }),
      ).rejects.toThrow('"the keeper" names 2 characters');
      const read = await loop.call("get-character", { name: "the keeper" });
      expect(read.found).toBe(false);
      expect(read.candidates).toEqual(["Isolde", "Maud"]);
    });

    it("shows aliases in get-character and list-characters", async () => {
      const read = await loop.call("get-character", { name: "伊索德" });
      expect(read._text).toContain("Also known as: the keeper, 伊索德");
      const list = await loop.call("list-characters", {});
      expect(list._text).toContain("Isolde (aka the keeper, 伊索德) [npc]");
      expect(list._text).toMatch(/\d\. Corvin \[npc\]/);
    });
  });

  describe("update-character _text output", () => {
    it("summarizes what changed in the returned _text", async () => {
      const created = await loop.call("create-character", {
        name: "赵铁山",
        type: "npc",
        fields: { hp: 100, status: "alive" },
      });
      const charId = (created as { characterId: string }).characterId;

      const result = (await loop.call("update-character", {
        id: charId,
        fields: { hp: 50, status: "wounded" },
        description: "updated desc",
      })) as { _text: string; version: number };

      expect(getToolContent(result).version).toBe(2);
      expect(typeof getToolContent(result)._text).toBe("string");
      expect(getToolContent(result)._text).toContain("赵铁山");
      expect(getToolContent(result)._text).toMatch(/hp/);
      expect(getToolContent(result)._text).toMatch(/status/);
    });

    it("reports the missing character id in its rejection", async () => {
      await expect(
        loop.call("update-character", {
          id: "missing",
          fields: { hp: 1 },
        }),
      ).rejects.toThrow('Character "missing" not found');
    });
  });

  // ── character-tracker workflow simulation (effects isolation) ────
  describe("effects isolation: buffered writes commit atomically", () => {
    it("create A → list (sees A) → create B (dedup sees A) → update A, no store write until commit", async () => {
      // create A
      const a = await loop.call("create-character", {
        name: "Aria",
        type: "npc",
        fields: { hp: 100 },
      });
      const aId = (a as { characterId: string }).characterId;

      // list sees the buffered A
      const list1 = (await loop.call("list-characters", {})) as {
        count: number;
        _text: string;
      };
      expect(list1.count).toBe(1);
      expect(list1._text).toContain("Aria");

      // create B — dedup does NOT match A (different name), new proposal
      const b = await loop.call("create-character", {
        name: "Borin",
        type: "npc",
      });
      const bId = (b as { characterId: string }).characterId;
      expect(bId).not.toBe(aId);

      // update A — sees its own buffered create as the base
      const upd = await loop.call("update-character", {
        id: aId,
        fields: { hp: 40 },
      });
      expect((upd as { version: number }).version).toBe(2);

      // Throughout the loop the store stays untouched.
      expect(store.characters).toHaveLength(0);
      expect(store.pluginData).toHaveLength(0);

      // finalize → everything lands.
      loop.commit();
      expect(store.characters).toHaveLength(2);
      const aRow = store.characters.find((c) => c.id === aId)!;
      expect(aRow.name).toBe("Aria");
      expect(aRow.version).toBe(2);
      expect((aRow.fields as { hp: number }).hp).toBe(40);
      expect(store.characters.find((c) => c.id === bId)!.name).toBe("Borin");
    });

    it("rollback (never commit) leaves the store with zero changes", async () => {
      await loop.call("create-character", { name: "Ghost", type: "npc" });
      await loop.call("update-character", {
        id: (loop.pending[0]!.payload as { id: string }).id,
        fields: { hp: 1 },
      });
      // Execution rolls back → commit() is never called.
      expect(store.characters).toHaveLength(0);
      expect(store.pluginData).toHaveLength(0);
    });
  });
});
