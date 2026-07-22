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
import type { Proposal } from "@covel/shared";
import { getPendingProposals } from "../src/result.js";
import {
  createCharacterTools,
  mirrorCharacterToPluginData,
} from "../src/builtin/character-tools.js";
import type { ToolModule, ToolExecutionContext } from "../src/types.js";

interface CharacterLike {
  id: string;
  sessionId: string;
  name: string;
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
    upsertCharacter(record: CharacterLike) {
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
 * the real commit handler (character write + mirror to each mirrorPluginId).
 */
function commitCharacterProposals(
  store: MockStore,
  pending: readonly Proposal[],
): void {
  for (const p of pending) {
    if (p.type !== "character.upsert") continue;
    const pl = p.payload;
    // Use the proposal's logical timestamp for updatedAt so a sequence of
    // buffered writes keeps a deterministic order in tests (the real commit
    // handler stamps commit-time now; ordering among same-turn writes is a
    // deliberate don't-care under the proposal model).
    const ts = p.timestamp;
    store.upsertCharacter({
      id: pl.id,
      sessionId: p.sessionId,
      name: pl.name,
      type: pl.type ?? "npc",
      description: pl.description,
      fields: pl.fields,
      version: pl.version ?? 1,
      createdAt: pl.createdAt ?? ts,
      updatedAt: ts,
    });
    const mirrors = [
      ...(pl.mirrorPluginId ? [pl.mirrorPluginId] : []),
      ...(pl.mirrorPluginIds ?? []),
    ].filter((id, i, all) => all.indexOf(id) === i);
    for (const mid of mirrors) {
      store.setPluginData({
        id: crypto.randomUUID(),
        sessionId: p.sessionId,
        pluginId: mid,
        namespace: "characters",
        key: pl.id,
        value: {
          id: pl.id,
          name: pl.name,
          type: pl.type ?? "npc",
          description: pl.description,
          fields: pl.fields,
          version: pl.version ?? 1,
          createdAt: pl.createdAt ?? ts,
          updatedAt: ts,
        },
        createdAt: ts,
        updatedAt: ts,
      });
    }
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
    return result as Record<string, unknown>;
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

  it("factory returns four named tools", () => {
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "create-character",
      "get-character",
      "list-characters",
      "update-character",
    ]);
  });

  it("mirror helper upserts one plugin-data row keyed by character id", async () => {
    const character = {
      id: "char-player-1",
      name: "柳无痕",
      type: "player",
      description: "外门弟子",
      fields: { hp: 100 },
      version: 1,
      createdAt: "2026-04-25T00:00:00.000Z",
      updatedAt: "2026-04-25T00:00:00.000Z",
    };

    await mirrorCharacterToPluginData(
      store,
      "sess-1",
      "char-creator",
      character,
    );
    await mirrorCharacterToPluginData(store, "sess-1", "char-creator", {
      ...character,
      fields: { hp: 90 },
      version: 2,
      updatedAt: "2026-04-25T00:01:00.000Z",
    });

    expect(store.pluginData).toHaveLength(1);
    expect(store.pluginData[0]).toMatchObject({
      id: "char-mirror-char-player-1",
      sessionId: "sess-1",
      pluginId: "char-creator",
      namespace: "characters",
      key: "char-player-1",
    });
    expect(store.pluginData[0].value).toMatchObject({
      id: "char-player-1",
      name: "柳无痕",
      type: "player",
      fields: { hp: 90 },
      version: 2,
    });
  });

  describe("create-character", () => {
    it("emits a character.upsert proposal that persists on commit", async () => {
      const result = await loop.call("create-character", {
        name: "柳无痕",
        type: "player",
        description: "外门弟子，灵识敏锐",
        fields: { hp: 100, level: 1, lingGen: "水灵根" },
      });

      expect(result).toMatchObject({
        success: true,
        characterId: expect.any(String),
        name: "柳无痕",
        type: "player",
      });
      // DELIBERATE CHANGE: nothing written during execution.
      expect(store.characters).toHaveLength(0);
      expect(loop.pending).toHaveLength(1);
      expect(loop.pending[0].type).toBe("character.upsert");

      loop.commit();
      expect(store.characters).toHaveLength(1);
      const char = store.characters[0];
      expect(char.sessionId).toBe("sess-1");
      expect(char.name).toBe("柳无痕");
      expect(char.type).toBe("player");
      expect(char.description).toBe("外门弟子，灵识敏锐");
      expect(char.fields).toEqual({ hp: 100, level: 1, lingGen: "水灵根" });
      expect(char.version).toBe(1);
    });

    it("mirrors character to plugin-data for panel reactivity (on commit)", async () => {
      const result = await loop.call(
        "create-character",
        { name: "Alice", type: "npc" },
        "char-creator",
      );
      const charId = (result as { characterId: string }).characterId;

      // Mirror rides on the proposal's mirrorPluginId — no direct write.
      expect(store.pluginData).toHaveLength(0);
      expect(
        (loop.pending[0].payload as { mirrorPluginId?: string }).mirrorPluginId,
      ).toBe("char-creator");

      loop.commit();
      expect(store.pluginData).toHaveLength(1);
      const mirror = store.pluginData[0];
      expect(mirror.pluginId).toBe("char-creator");
      expect(mirror.namespace).toBe("characters");
      expect(mirror.key).toBe(charId);
      expect((mirror.value as { name: string }).name).toBe("Alice");
      expect((mirror.value as { type: string }).type).toBe("npc");
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
      expect(typeof result._text).toBe("string");
      expect(result._text).toContain("柳无痕");
      expect(result._text).toContain("player");
      expect(result._text).toContain(result.characterId);
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

      expect(result).toMatchObject({
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

    it("re-mirrors updated character to plugin-data on commit", async () => {
      const created = await loop.call("create-character", {
        name: "X",
        type: "npc",
      });
      const charId = (created as { characterId: string }).characterId;

      await loop.call("update-character", { id: charId, fields: { hp: 20 } });

      loop.commit();
      const mirror = store.pluginData.find(
        (r) => r.namespace === "characters" && r.key === charId,
      );
      expect(mirror).toBeDefined();
      expect((mirror!.value as { fields: { hp: number } }).fields.hp).toBe(20);
    });

    it("returns notFound when id does not exist", async () => {
      const result = await loop.call("update-character", {
        id: "nonexistent",
        fields: { hp: 1 },
      });
      expect(result).toMatchObject({ success: false, notFound: true });
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
      expect(typeof result._text).toBe("string");
      expect(result.count).toBe(3);
      expect(result._text).toContain("柳无痕");
      expect(result._text).toContain("苏婉");
      expect(result._text).toContain("柳娘");
      expect(result._text).toContain("外门弟子");
      expect(result._text).toContain("player");
      expect(result._text).toContain("npc");
    });

    it("filters by type when provided", async () => {
      const result = (await loop.call("list-characters", { type: "npc" })) as {
        _text: string;
        count: number;
      };
      expect(result.count).toBe(2);
      expect(result._text).toContain("苏婉");
      expect(result._text).toContain("柳娘");
      expect(result._text).not.toContain("柳无痕");
    });

    it("handles empty session with a clear empty message", async () => {
      const emptyStore = createMockStore();
      const emptyLoop = new Loop(createCharacterTools(emptyStore), emptyStore);
      const result = (await emptyLoop.call("list-characters", {})) as {
        _text: string;
        count: number;
      };
      expect(result.count).toBe(0);
      expect(result._text.toLowerCase()).toMatch(
        /no character|empty|没有|暂无/,
      );
    });

    it('treats "None" filter values as no filter', async () => {
      const result = (await loop.call("list-characters", {
        type: "None",
      })) as { _text: string; count: number };
      expect(result.count).toBe(3);
      expect(result._text).toContain("柳无痕");
      expect(result._text).toContain("苏婉");
      expect(result._text).toContain("柳娘");
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
      expect(result.count).toBe(4);
      expect(result._text).toContain("NarratorGhost");
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
      expect(result.found).toBe(true);
      expect(typeof result._text).toBe("string");
      expect(result._text).toContain("柳无痕");
      expect(result._text).toContain("player");
      expect(result._text).toContain(charId);
      expect(result._text).toContain("hp");
      expect(result._text).toContain("100");
    });

    it("looks up by name and returns full detail", async () => {
      const result = (await loop.call("get-character", { name: "柳无痕" })) as {
        _text: string;
        found: boolean;
      };
      expect(result.found).toBe(true);
      expect(result._text).toContain("柳无痕");
      expect(result._text).toContain("player");
    });

    it("returns text saying not found when id is missing", async () => {
      const result = (await loop.call("get-character", { id: "nope" })) as {
        _text: string;
        found: boolean;
      };
      expect(result.found).toBe(false);
      expect(result._text.toLowerCase()).toMatch(/not found|未找到|不存在/);
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
      expect(result.found).toBe(true);
      expect(result._text).toContain("未落库者");
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

      expect(result.version).toBe(2);
      expect(typeof result._text).toBe("string");
      expect(result._text).toContain("赵铁山");
      expect(result._text).toMatch(/hp/);
      expect(result._text).toMatch(/status/);
    });

    it("returns a not-found text when id does not exist", async () => {
      const result = (await loop.call("update-character", {
        id: "missing",
        fields: { hp: 1 },
      })) as { _text: string; success: boolean; notFound?: boolean };
      expect(result.success).toBe(false);
      expect(result.notFound).toBe(true);
      expect(result._text.toLowerCase()).toMatch(/not found|未找到|不存在/);
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
        id: (loop.pending[0].payload as { id: string }).id,
        fields: { hp: 1 },
      });
      // Execution rolls back → commit() is never called.
      expect(store.characters).toHaveLength(0);
      expect(store.pluginData).toHaveLength(0);
    });
  });
});
