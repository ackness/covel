/**
 * codex plugin tests.
 *
 * After the function→agent runtime switch (see PLUGIN.md rewrite), the
 * deterministic-extraction path is gone and the plugin is now LLM-driven
 * with local tools. These tests cover:
 *
 * 1. Local tools: `unlock-codex-entries` + `update-codex-entry` (pure,
 *    independent of runtime type — verified against an in-memory store stub)
 * 2. Plugin manifest: agent runtime shape, declares local tools,
 *    `input.inject` contains both `narrator` runtime inject and the
 *    plugin-data inject that feeds existing entries into the prompt.
 * 3. UI declarations unchanged.
 *
 * Integration-level coverage (real LLM calling the tool chain) lives in
 * `scripts/e2e-plugin-verify.ts`, not here.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import path from "node:path";
import {
  discoverPlugins,
  loadPluginManifest,
  loadRuntime,
} from "@covel/plugin-loader";
import { getPendingProposals, tool, z, shortIdBatch } from "@covel/tools";
import createUnlockCodexEntries from "../tools/unlock-codex-entries.js";
import createUpdateCodexEntry from "../tools/update-codex-entry.js";
import {
  CODEX_CATEGORY_METADATA,
  getCategoryMetadata,
} from "../category-metadata.js";

// In-memory mock store for plugin-data operations
function createMockPluginDataStore() {
  /** @type {Map<string, unknown>} */
  const data = new Map();
  const makeKey = (sid, pid, ns, k) => `${sid}:${pid}:${ns}:${k}`;

  return {
    data,
    async setPluginData(record) {
      data.set(
        makeKey(
          record.sessionId,
          record.pluginId,
          record.namespace,
          record.key,
        ),
        {
          namespace: record.namespace,
          key: record.key,
          value: record.value,
          updatedAt: record.updatedAt,
        },
      );
    },
    async setPluginDataBatch(records) {
      for (const r of records) await this.setPluginData(r);
    },
    async getPluginData(sessionId, pluginId, namespace, key) {
      return data.get(makeKey(sessionId, pluginId, namespace, key)) ?? null;
    },
    async listPluginData(sessionId, pluginId, namespace) {
      const results = [];
      for (const [k, v] of data) {
        if (
          k.startsWith(`${sessionId}:${pluginId}:`) &&
          (!namespace || k.startsWith(`${sessionId}:${pluginId}:${namespace}:`))
        ) {
          results.push(v);
        }
      }
      return results;
    },
  };
}

async function applyPendingPluginData(result, store) {
  for (const proposal of getPendingProposals(result)) {
    if (proposal.type === "plugin.data") {
      await store.setPluginData({
        id: proposal.id,
        sessionId: proposal.sessionId,
        pluginId: proposal.source.pluginId,
        namespace: proposal.payload.namespace,
        key: proposal.payload.key,
        value: proposal.payload.value,
        createdAt: proposal.timestamp,
        updatedAt: proposal.timestamp,
      });
      continue;
    }

    if (proposal.type === "plugin.data.batch") {
      await store.setPluginDataBatch(
        proposal.payload.items.map((item, index) => ({
          id: `${proposal.id}:${index}`,
          sessionId: proposal.sessionId,
          pluginId: proposal.source.pluginId,
          namespace: item.namespace,
          key: item.key,
          value: item.value,
          createdAt: proposal.timestamp,
          updatedAt: proposal.timestamp,
        })),
      );
    }
  }
}

async function executeAndCommit(toolModule, params, context, store) {
  const result = await toolModule.execute(params, context);
  await applyPendingPluginData(result, store);
  return result;
}

const PLUGINS_DIR = path.resolve(import.meta.dirname, "../..");

// ── Tool unit tests ──────────────────────────────────────────────

describe("codex tools", () => {
  const ctx = {
    sessionId: "sess-1",
    turnId: "turn-1",
    pluginId: "codex",
    runtimeId: "codex",
  };
  let mockStore;
  let unlockCodexEntriesTool;
  let updateCodexEntryTool;

  beforeEach(() => {
    mockStore = createMockPluginDataStore();
    unlockCodexEntriesTool = createUnlockCodexEntries({
      tool,
      z,
      shortIdBatch,
      store: mockStore,
    });
    updateCodexEntryTool = createUpdateCodexEntry({
      tool,
      z,
      store: mockStore,
    });
  });

  describe("unlock-codex-entries", () => {
    it("should unlock a single entry with UI card", async () => {
      const result = await executeAndCommit(
        unlockCodexEntriesTool,
        {
          entries: [
            {
              category: "location",
              title: "青萍山",
              content: "青萍宗所在的灵脉山峰，外门在山腰，内门在山顶。",
              tags: ["宗门", "灵脉"],
              rarity: "common",
            },
          ],
        },
        ctx,
        mockStore,
      );

      expect(result.unlocked).toBe(1);
      expect(result.entries[0].title).toBe("青萍山");
      expect(result.entries[0].entryId).toBeDefined();
      // UI blocks use the generic `ui-spec` convention: the block carries a
      // self-contained json-render spec tree instead of a codex-specific type.
      expect(result.ui[0].type).toBe("ui-spec");
      expect(result.ui[0].spec.type).toBe("EntryCard");
      expect(result.ui[0].spec.props.title).toBe("青萍山");
      expect(result.ui[0].spec.props.category).toBe("location");
      expect(result.ui[0].spec.props.isNew).toBe(true);
    });

    it("should persist entries to plugin-data store", async () => {
      const result = await executeAndCommit(
        unlockCodexEntriesTool,
        {
          entries: [
            {
              category: "location",
              title: "青萍山",
              content: "青萍宗所在的灵脉山峰。",
              tags: ["宗门"],
              rarity: "common",
            },
          ],
        },
        ctx,
        mockStore,
      );

      const entryId = result.entries[0].entryId;
      const stored = await mockStore.getPluginData(
        "sess-1",
        "codex",
        "entries",
        entryId,
      );
      expect(stored).not.toBeNull();
      expect(stored.value.title).toBe("青萍山");
      expect(stored.value.category).toBe("location");
      // Freshly unlocked entries carry the generic `isNew` flag so the UI
      // can decorate the card without a codex-specific side-channel.
      expect(stored.value.isNew).toBe(true);
      // Each persisted value self-describes its category for the UI.
      expect(stored.value.categoryMeta).toEqual({
        displayName: { zh: "地点", en: "Locations" },
        icon: "MapPin",
        color: "blue",
      });
    });

    it("should attach categoryMeta for every known category", async () => {
      const categories = Object.keys(CODEX_CATEGORY_METADATA);
      const result = await executeAndCommit(
        unlockCodexEntriesTool,
        {
          entries: categories.map((category) => ({
            category,
            title: `测试-${category}`,
            content: `这是一个 ${category} 类目的测试条目，用于验证 categoryMeta 注入逻辑。`,
            tags: [category],
            rarity: "common",
          })),
        },
        ctx,
        mockStore,
      );

      for (let i = 0; i < categories.length; i++) {
        const category = categories[i];
        const stored = await mockStore.getPluginData(
          "sess-1",
          "codex",
          "entries",
          result.entries[i].entryId,
        );
        expect(stored.value.categoryMeta).toEqual(
          CODEX_CATEGORY_METADATA[category],
        );
      }
    });

    it("should batch unlock multiple entries", async () => {
      const result = await executeAndCommit(
        unlockCodexEntriesTool,
        {
          entries: [
            {
              category: "character",
              title: "苏婉",
              content: "青萍宗外门首席弟子，冰灵根。",
              tags: ["弟子", "冰灵根"],
              rarity: "uncommon",
            },
            {
              category: "item",
              title: "梦莲",
              content: "野生灵植，可短暂扩展灵识但有成瘾风险。",
              tags: ["灵植", "危险"],
              rarity: "rare",
            },
            {
              category: "monster",
              title: "瘴气蟾蜍",
              content: "百灵沼泽常见妖兽，练气中期实力。",
              tags: ["妖兽", "沼泽"],
              rarity: "common",
            },
          ],
        },
        ctx,
        mockStore,
      );

      expect(result.unlocked).toBe(3);
      expect(result.ui).toHaveLength(3);
      // Each block is a generic ui-spec carrying an EntryCard spec.
      // Rarity is reflected in spec.props.rarity; the renderer handles
      // rarity → border/animation mapping (no plugin-side style tokens).
      expect(result.ui[0].spec.props.rarity).toBe("uncommon");
      expect(result.ui[1].spec.props.rarity).toBe("rare");
      expect(result.ui[2].spec.props.rarity).toBe("common");

      const stored = await mockStore.listPluginData(
        "sess-1",
        "codex",
        "entries",
      );
      expect(stored).toHaveLength(3);
    });

    it("should generate legendary entry with glow animation", async () => {
      const result = await executeAndCommit(
        unlockCodexEntriesTool,
        {
          entries: [
            {
              category: "lore",
              title: "上古灵潮",
              content: "远古天地灵气复苏事件，云梦泽由此成为灵气最浓郁的区域。",
              tags: ["上古", "灵气", "历史"],
              rarity: "legendary",
              imageHint: "远古天空裂开，金色灵气如瀑布倾泻而下",
            },
          ],
        },
        ctx,
        mockStore,
      );

      expect(result.ui[0].spec.props.rarity).toBe("legendary");
      // imageHint is kept in block `meta` so tools/traces can still see it,
      // without pushing codex-specific styling into the spec tree.
      expect(result.ui[0].meta.imageHint).toBe(
        "远古天空裂开，金色灵气如瀑布倾泻而下",
      );
    });
  });

  describe("update-codex-entry", () => {
    it("should update existing entry from store", async () => {
      const unlockResult = await executeAndCommit(
        unlockCodexEntriesTool,
        {
          entries: [
            {
              category: "location",
              title: "青萍山",
              content: "青萍宗所在的灵脉山峰。",
              tags: ["宗门"],
              rarity: "common",
            },
          ],
        },
        ctx,
        mockStore,
      );

      const entryId = unlockResult.entries[0].entryId;

      const result = await executeAndCommit(
        updateCodexEntryTool,
        {
          entryId,
          appendContent: "据传青萍山灵脉近年有衰退迹象，原因不明。",
        },
        ctx,
        mockStore,
      );

      expect(result.updated).toBe(true);
      expect(result.entryId).toBe(entryId);
      // Updates use the same generic ui-spec convention as unlocks.
      expect(result.ui[0].type).toBe("ui-spec");
      expect(result.ui[0].spec.type).toBe("EntryCard");

      const stored = await mockStore.getPluginData(
        "sess-1",
        "codex",
        "entries",
        entryId,
      );
      expect(stored.value.content).toContain("衰退迹象");
    });

    it("should backfill categoryMeta when updating a pre-B2 entry", async () => {
      // Simulate an entry written before B2 (no categoryMeta on the value).
      const legacyId = "codex-legacy-entry";
      await mockStore.setPluginData({
        id: "legacy-record-id",
        sessionId: "sess-1",
        pluginId: "codex",
        namespace: "entries",
        key: legacyId,
        value: {
          category: "lore",
          title: "上古传说",
          content: "一段在 B2 之前已经写入的旧条目。",
          tags: ["legacy"],
          rarity: "common",
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      await executeAndCommit(
        updateCodexEntryTool,
        {
          entryId: legacyId,
          appendContent: "新增补充信息。",
        },
        ctx,
        mockStore,
      );

      const stored = await mockStore.getPluginData(
        "sess-1",
        "codex",
        "entries",
        legacyId,
      );
      expect(stored.value.categoryMeta).toEqual(getCategoryMetadata("lore"));
    });

    it("should update a freshly unlocked entry before the turn commits", async () => {
      const unlockResult = await unlockCodexEntriesTool.execute(
        {
          entries: [
            {
              category: "location",
              title: "青萍山",
              content: "青萍宗所在的灵脉山峰。",
              tags: ["宗门"],
              rarity: "common",
            },
          ],
        },
        ctx,
      );

      const entryId = unlockResult.entries[0].entryId;
      const result = await updateCodexEntryTool.execute(
        {
          entryId,
          appendContent: "山顶近来出现新的古阵波动。",
        },
        {
          ...ctx,
          pendingProposals: getPendingProposals(unlockResult),
        },
      );

      expect(result.updated).toBe(true);
      expect(result.entryId).toBe(entryId);

      await applyPendingPluginData(unlockResult, mockStore);
      await applyPendingPluginData(result, mockStore);

      const stored = await mockStore.getPluginData(
        "sess-1",
        "codex",
        "entries",
        entryId,
      );
      expect(stored.value.content).toContain("古阵波动");
    });

    it("should return error for non-existent entry", async () => {
      const result = await executeAndCommit(
        updateCodexEntryTool,
        {
          entryId: "codex-nonexistent",
          appendContent: "some content",
        },
        ctx,
        mockStore,
      );

      expect(result.updated).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("should support rarity upgrade", async () => {
      const unlockResult = await executeAndCommit(
        unlockCodexEntriesTool,
        {
          entries: [
            {
              category: "item",
              title: "梦莲",
              content: "野生灵植，可短暂扩展灵识但有成瘾风险。",
              tags: ["灵植"],
              rarity: "common",
            },
          ],
        },
        ctx,
        mockStore,
      );
      const entryId = unlockResult.entries[0].entryId;

      const result = await executeAndCommit(
        updateCodexEntryTool,
        {
          entryId,
          appendContent: "发现梦莲与上古封印有直接关联！",
          rarityUpgrade: "legendary",
        },
        ctx,
        mockStore,
      );

      // rarityUpgrade lives in block meta (observability only). The spec
      // props surface the new rarity via `rarity`; the renderer handles the
      // visual treatment without any upgrade-specific plugin tokens.
      expect(result.ui[0].meta.rarityUpgrade).toBe("legendary");
      expect(result.ui[0].spec.props.rarity).toBe("legendary");

      const stored = await mockStore.getPluginData(
        "sess-1",
        "codex",
        "entries",
        entryId,
      );
      expect(stored.value.rarity).toBe("legendary");
    });
  });
});

// ── Category metadata helper tests ───────────────────────────────

describe("getCategoryMetadata", () => {
  it("returns the canonical entry for known categories", () => {
    expect(getCategoryMetadata("monster")).toEqual(
      CODEX_CATEGORY_METADATA.monster,
    );
    expect(getCategoryMetadata("skill")).toEqual(CODEX_CATEGORY_METADATA.skill);
  });

  it("returns a safe fallback for unknown categories", () => {
    const meta = getCategoryMetadata("mystery-future-category");
    expect(meta.icon).toBe("BookOpen");
    expect(meta.color).toBe("gray");
    // displayName echoes the raw category so the UI still has *something*.
    expect(meta.displayName).toEqual({
      zh: "mystery-future-category",
      en: "mystery-future-category",
    });
  });
});

// ── Plugin manifest tests ────────────────────────────────────────

describe("codex plugin manifest", () => {
  /** @type {import('@covel/shared').RuntimeManifest} */
  let manifest;
  let loaded;

  beforeAll(async () => {
    const discoveries = await discoverPlugins(PLUGINS_DIR);
    const discovery = discoveries.find((d) => d.id === "codex");
    const manifests = await loadPluginManifest(discovery);
    manifest = manifests[0].manifest;
    loaded = await loadRuntime(discovery, manifest.name);
  });

  it("should be a non-core agent-runtime plugin", () => {
    expect(manifest.pluginType).toBe("plugin");
    expect(manifest.name).toBe("codex");
    // Narrator-downstream layer — shares 600 with guide / extractor /
    // character-tracker so the scheduler runs all four in parallel.
    expect(manifest.priority).toBe(600);
    // Agent runtime — no `runtimeType` field means default 'agent'
    expect(manifest.runtimeType).toBeUndefined();
    expect(manifest.handler).toBeUndefined();
  });

  it("should declare both narrative-engine runtime injects and the plugin-data inject", () => {
    const injects = manifest.input?.inject ?? [];
    expect(injects).toHaveLength(3);

    // Engine-agnostic : one runtime inject per known narrative engine;
    // the absent engine resolves to nothing so exactly the active one fills
    // the <narrator-output> block.
    for (const engine of ["narrator", "chat-mode-narrator"]) {
      expect(injects).toContainEqual({
        kind: "runtime",
        from: engine,
        field: "narrativeOutput",
        as: "<narrator-output>",
      });
    }

    // Plus: plugin-data inject from its own `entries` namespace
    expect(injects).toContainEqual(
      expect.objectContaining({
        kind: "plugin-data",
        namespace: "entries",
        as: "<existing-entries>",
        format: "summary",
        maxEntries: 100,
      }),
    );
  });

  it("should declare unlock + update plugin tools but NOT plugin-data-list", () => {
    expect(manifest.tools?.plugin).toEqual([
      "unlock-codex-entries",
      "update-codex-entry",
    ]);
    // plugin-data-list was removed — existing entries now arrive via input.inject
    expect(manifest.tools?.builtin ?? []).not.toContain("plugin-data-list");
  });

  it("should declare post-history completion contract", () => {
    expect(manifest.postHistory?.content).toContain("<existing-entries>");
  });

  it("should load PLUGIN.md body as the LLM prompt template", () => {
    expect(loaded.promptTemplate).toContain("知识图鉴");
    expect(loaded.promptTemplate).toContain("<existing-entries>");
  });

  it("should have auto trigger (runs every turn after the narrative engine)", () => {
    // Post 2026-04 refactor: codex runs every turn so no narrative is lost
    // between discovery passes. Priority 600 plus the narrative-engine
    // capability gate  ensure codex (and its peers guide / extractor /
    // character-tracker) schedule after the active engine completes; on that
    // layer the DAG scheduler executes them concurrently.
    expect(manifest.trigger?.type).toBe("auto");
    expect(manifest.upstreamRequired).toEqual([
      { capability: "narrative-engine" },
    ]);
  });

  it("should declare right panel UI spec", () => {
    expect(manifest.ui).toBeDefined();
    expect(manifest.ui?.right).toContain("./ui/codex-panel.json");
  });

  it("should load UI spec JSON with panel metadata", () => {
    expect(loaded.uiSpecs).toBeDefined();
    expect(loaded.uiSpecs?.right).toHaveLength(1);
    expect(loaded.uiSpecs?.right?.[0].id).toBe("codex");
    expect(loaded.uiSpecs?.right?.[0].icon).toBe("book-open");
  });
});
