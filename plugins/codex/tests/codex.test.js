import { readFileSync as readContractFile } from "node:fs";
import {
  bindToolStore,
  createPluginTestStore,
  executeToolAndCommit as executeAndCommit,
} from "@covel/plugin-test-utils";
/**
 * codex plugin tests.
 *
 * 1. `sync-codex-entries`: one call creates new entries and adds to
 *    existing ones matched by title, verified against the real in-memory
 *    store and commit boundary.
 * 2. Plugin manifest: agent runtime shape, the single local tool, and the
 *    plugin-data inject that feeds existing entries into the prompt.
 * 3. UI declarations.
 *
 * Integration-level coverage (real LLM calling the tool) lives in
 * `scripts/e2e-plugin-verify.ts`, not here.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import path from "node:path";
import {
  discoverPlugins,
  loadPluginDefinition,
  loadPluginUi,
  loadRuntime,
  resolveRuntimePrompt,
} from "@covel/plugin-loader";
import {
  getPendingProposals,
  getToolContent,
} from "@covel/plugin-handlers-utils";
import { tool, z } from "@covel/tools";
import createSyncCodexEntries from "../tools/sync-codex-entries.js";
import {
  CODEX_CATEGORY_METADATA,
  getCategoryMetadata,
} from "../category-metadata.js";

const PLUGINS_DIR = path.resolve(import.meta.dirname, "../..");

// ── Tool unit tests ──────────────────────────────────────────────

describe("sync-codex-entries", () => {
  const ctx = {
    sessionId: "sess-1",
    turnId: "turn-1",
    pluginId: "codex",
    runtimeId: "codex",
  };
  let mockStore;
  let syncTool;
  const sync = async (entries) =>
    getToolContent(
      await executeAndCommit(syncTool, { entries }, ctx, mockStore),
    );
  const stored = async (key) =>
    (await mockStore.getPluginData("sess-1", "codex", "entries", key))?.value;
  const mountain = {
    category: "location",
    title: "Azure Peak",
    content: "青萍宗所在的灵脉山峰，外门在山腰，内门在山顶。",
    tags: ["宗门", "灵脉"],
  };

  beforeEach(async () => {
    mockStore = await createPluginTestStore(ctx);
    syncTool = bindToolStore(createSyncCodexEntries({ tool, z }), mockStore);
  });

  it("creates an entry keyed by its title, with a discovery card", async () => {
    const result = await sync([mountain]);

    expect(result.created).toEqual(["codex-azure-peak"]);
    expect(result.ui[0]).toMatchObject({
      type: "ui-spec",
      entryId: "codex-azure-peak",
      spec: {
        type: "EntryCard",
        props: { title: "Azure Peak", category: "location", isNew: true },
      },
    });
    expect(await stored("codex-azure-peak")).toMatchObject({
      title: "Azure Peak",
      category: "location",
      rarity: "common",
      isNew: true,
      categoryMeta: { icon: "MapPin", color: "blue" },
    });
  });

  it("adds to the entry with the same title instead of creating one", async () => {
    await sync([mountain]);
    const result = await sync([
      {
        category: "lore",
        title: "  azure PEAK ",
        content: "山顶近来出现了新的古阵波动。",
        tags: ["古阵"],
        rarity: "rare",
      },
    ]);

    expect(result).toMatchObject({
      created: [],
      updated: ["codex-azure-peak"],
    });
    expect(result.ui[0].spec.props).toMatchObject({
      content: "山顶近来出现了新的古阵波动。",
      tags: ["古阵"],
    });
    const value = await stored("codex-azure-peak");
    expect(value.category).toBe("location");
    expect(value.content).toBe(
      `${mountain.content}\n\n山顶近来出现了新的古阵波动。`,
    );
    expect(value.tags).toEqual(["宗门", "灵脉", "古阵"]);
    expect(value.rarity).toBe("rare");
    // Adding with a lower rarity never downgrades the entry.
    await sync([{ ...mountain, content: "外门正在扩建。", rarity: "common" }]);
    expect((await stored("codex-azure-peak")).rarity).toBe("rare");
  });

  it("keeps one character entry for a session character named by an alias, and leaves other categories alone", async () => {
    const world = {
      characters: [
        { id: "npc-ysolde", name: "Keeper Ysolde", aliases: ["the Keeper"] },
      ],
    };
    const syncWithCast = async (entries) =>
      getToolContent(
        await executeAndCommit(
          syncTool,
          { entries },
          { ...ctx, world },
          mockStore,
        ),
      );
    await syncWithCast([
      {
        category: "character",
        title: "Keeper Ysolde",
        content: "She tends the barrow lantern.",
      },
    ]);
    const result = await syncWithCast([
      {
        category: "character",
        title: "The Keeper",
        content: "She has not left the hill in ten years.",
      },
      {
        category: "lore",
        title: "The Keeper",
        content: "An office of the Dawn Lantern order.",
      },
    ]);
    expect(result).toMatchObject({
      created: ["codex-the-keeper"],
      updated: ["codex-keeper-ysolde"],
    });
    expect((await stored("codex-keeper-ysolde")).content).toContain(
      "ten years",
    );
  });

  it("does not append a sentence the entry already holds", async () => {
    await sync([mountain]);
    await sync([mountain]);
    expect((await stored("codex-azure-peak")).content).toBe(mountain.content);
  });

  it("marks only the latest sync's entries as new", async () => {
    await sync([mountain]);
    const second = await sync([{ ...mountain, title: "Jade Pool" }]);
    expect(second.updated).toEqual([]);
    expect((await stored("codex-azure-peak")).isNew).toBe(false);
    expect((await stored("codex-jade-pool")).isNew).toBe(true);

    // Adding to an entry written before is not a discovery either.
    await sync([{ ...mountain, title: "Jade Pool", content: "水很凉。" }]);
    expect((await stored("codex-jade-pool")).isNew).toBe(false);
  });

  it("matches titles case-insensitively and keys English titles as words", async () => {
    await sync([{ ...mountain, title: "West Herb Garden" }]);
    const result = await sync([
      { ...mountain, title: "west herb garden", content: "Fenced at night." },
    ]);
    expect(result.updated).toEqual(["codex-west-herb-garden"]);
  });

  it("finds entries under any key and backfills their category metadata", async () => {
    await mockStore.setPluginData({
      id: "older-record",
      sessionId: "sess-1",
      pluginId: "codex",
      namespace: "entries",
      key: "codex-0f3a9c",
      value: {
        category: "lore",
        title: "上古传说",
        content: "一段较早写入的条目。",
        tags: [],
        rarity: "common",
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const result = await sync([
      { category: "lore", title: "上古传说", content: "新增补充信息。" },
    ]);

    expect(result.updated).toEqual(["codex-0f3a9c"]);
    expect((await stored("codex-0f3a9c")).categoryMeta).toEqual(
      getCategoryMetadata("lore"),
    );
  });

  it("writes one batch and keeps only the first three new titles", async () => {
    const entry = (title) => ({ ...mountain, title });
    const raw = await executeAndCommit(
      syncTool,
      {
        entries: [
          entry("One"),
          entry("Two"),
          { ...entry("One"), content: "A second fact." },
          entry("Three"),
          entry("Four"),
        ],
      },
      ctx,
      mockStore,
    );

    expect(getPendingProposals(raw)).toHaveLength(1);
    expect(getToolContent(raw)).toMatchObject({
      created: ["codex-one", "codex-two", "codex-three"],
      updated: [],
      skipped: ["Four"],
    });
    expect((await stored("codex-one")).content).toBe(
      `${mountain.content}\n\nA second fact.`,
    );
  });

  it("gives a new entry a free key when its title's key is taken", async () => {
    await mockStore.setPluginData({
      id: "other",
      sessionId: "sess-1",
      pluginId: "codex",
      namespace: "entries",
      key: "codex-azure-peak",
      value: { category: "lore", title: "另一条", content: "占用键名。" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect((await sync([mountain])).created).toEqual(["codex-azure-peak-2"]);
  });

  it("keys a title without ASCII words by a short random part", async () => {
    const result = await sync([{ ...mountain, title: "青萍山" }]);
    expect(result.created).toEqual([
      expect.stringMatching(/^codex-[0-9a-f]{8}$/),
    ]);
    // Later additions still find it by title.
    expect((await sync([{ ...mountain, title: "青萍山" }])).updated).toEqual(
      result.created,
    );
  });

  it("rejects an empty sync and reserves runtime-done for no-change turns", async () => {
    await expect(syncTool.execute({ entries: [] }, ctx)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
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
    // The name is not stored: entries go into the prompt in one language.
    expect(meta).not.toHaveProperty("displayName");
  });
});

// ── Plugin manifest tests ────────────────────────────────────────

describe("codex plugin manifest", () => {
  /** @type {import('@covel/shared').RuntimeManifest} */
  let manifest;
  let loaded;
  let declaration;
  let packageManifest;
  let loadedUi;

  beforeAll(async () => {
    const discoveries = await discoverPlugins(PLUGINS_DIR);
    const discovery = discoveries.find((d) => d.id === "codex");
    const definition = await loadPluginDefinition(discovery);
    const manifests = definition.manifests;
    packageManifest = definition.packageManifest.manifest;
    loadedUi = await loadPluginUi(discovery, undefined, definition);
    manifest = manifests[0].manifest;
    declaration = definition.packageManifest.plugin;
    loaded = await loadRuntime(discovery, manifest.name, undefined, undefined, {
      "world-ir@1": JSON.parse(
        readContractFile(
          new URL(
            "../../world-ir/schemas/world-ir.schema.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ),
    });
  });

  it("should be a non-core agent-runtime plugin", () => {
    expect(manifest.pluginType).toBe("plugin");
    expect(manifest.name).toBe("codex");
    // Narrator-downstream layer — post-turn stage, run in parallel with guide /
    // extractor / character-tracker.
    expect(manifest.stage).toBe("post-turn");
    // Agent runtime — no `runtimeType` field means default 'agent'
    expect(manifest.runtimeType).toBe("agent");
    expect(manifest.handler).toBeUndefined();
  });

  it("should consume typed WorldIR and inject existing plugin data", () => {
    expect(manifest.inputs?.worldIR).toEqual({
      from: { capability: "world-ir-provider@1", cardinality: "one" },
      accepts: "contract:world-ir@1",
      required: true,
    });
    expect(declaration.requires).toContain("world-ir-provider@1");

    const injects = manifest.input?.inject ?? [];
    expect(injects).toHaveLength(1);
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

  it("should expose one atomic sync tool but NOT plugin-data-list", () => {
    expect(manifest.tools?.plugin).toEqual(["sync-codex-entries"]);
    expect(manifest.completeAfterTools).toEqual(["sync-codex-entries"]);
    expect(manifest.maxSteps).toBeUndefined(); // Inherit the framework budget.
    expect(manifest.maxRetries).toBe(3);
    // plugin-data-list was removed — existing entries now arrive via input.inject
    expect(manifest.tools?.builtin ?? []).not.toContain("plugin-data-list");
  });

  it("should declare post-history completion contract", () => {
    expect(JSON.stringify(declaration.contributes.prompt)).toContain(
      "<existing-entries>",
    );
  });

  it("should load PLUGIN.md body as the LLM prompt template", async () => {
    expect(loaded.promptTemplate).toContain("Knowledge Codex Tracker");
    expect(loaded.promptTemplate).toContain("<existing-entries>");
    // A Chinese session reads the PLUGIN.zh.md variant of the same prompt.
    const discovery = (await discoverPlugins(PLUGINS_DIR)).find(
      (d) => d.id === "codex",
    );
    const chinese = resolveRuntimePrompt(
      (await loadPluginDefinition(discovery, "zh-CN")).manifests[0],
      "zh-CN",
    );
    expect(chinese).toContain("知识图鉴");
    expect(chinese).toContain("<existing-entries>");
  });

  it("should have auto trigger and rely on its typed WorldIR DAG edge", () => {
    // Post 2026-04 refactor: codex runs every turn so no narrative is lost
    // between discovery passes. The typed worldIR binding creates both the
    // same-turn dependency edge and the required failure gate.
    expect(manifest.trigger?.type).toBe("auto");
    expect(manifest.needs).toBeUndefined();
  });

  it("should declare right panel UI spec", () => {
    expect(packageManifest.ui).toBeDefined();
    expect(packageManifest.ui?.right).toContain("./ui/codex-panel.json");
  });

  it("should load UI spec JSON with panel metadata", () => {
    expect(loadedUi.uiSpecs).toBeDefined();
    expect(loadedUi.uiSpecs?.right).toHaveLength(1);
    expect(loadedUi.uiSpecs?.right?.[0].id).toBe("codex");
    expect(loadedUi.uiSpecs?.right?.[0].icon).toBe("book-open");
  });
});
