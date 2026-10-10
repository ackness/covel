import {
  getToolContent,
  getPendingProposals,
  shortIdBatch,
} from "@covel/plugin-handlers-utils";
import { readFileSync as readContractFile } from "node:fs";
import {
  bindToolStore,
  createPluginTestStore,
  executeToolAndCommit as executeAndCommit,
} from "@covel/plugin-test-utils";
/**
 * affinity plugin tests.
 *
 * Layers covered here:
 *
 * 1. Tier metadata: band boundaries (including the negative bands) and
 *    score clamping — pure helpers, tested directly.
 * 2. Local tool `update-affinity`: creation, accumulation + clamping at
 *    both bounds, history truncation, tolerance for world-preseeded
 *    records ({id, name, score, notes?} without derived fields), name
 *    de-duplication, message-namespace toast payload, and same-turn
 *    pending-proposal reads.
 * 3. Plugin manifest: post-turn agent shape, narrative-engine gate,
 *    injects, dataSchemas, and UI declarations.
 *
 * Integration-level coverage (real LLM calling the tool chain) lives in
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

import { tool, z } from "@covel/tools";
import createUpdateAffinity from "../tools/update-affinity.js";
import {
  AFFINITY_TIERS,
  clampScore,
  getTier,
  tierLabel,
} from "../tier-metadata.js";
import { loadPluginMessages } from "@covel/plugin-test-utils";

// What the host gives a tool as `context.messages` for a Chinese session.
const messages = await loadPluginMessages(
  new URL("..", import.meta.url),
  "zh-CN",
);

/** Seed a committed affinity record directly into the test store. */
async function seedRecord(store, key, value) {
  await store.setPluginData({
    id: `seed-${key}`,
    sessionId: "sess-1",
    pluginId: "affinity",
    namespace: "affinity",
    key,
    value,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

const PLUGINS_DIR = path.resolve(import.meta.dirname, "../..");

// ── Tier metadata tests ──────────────────────────────────────────

describe("tier metadata", () => {
  it.each([
    [-100, "hostile"],
    [-60, "hostile"],
    [-59, "cold"],
    [-20, "cold"],
    [-19, "neutral"],
    [0, "neutral"],
    [19, "neutral"],
    [20, "friendly"],
    [59, "friendly"],
    [60, "close"],
    [84, "close"],
    [85, "devoted"],
    [100, "devoted"],
  ])("maps score %i to tier %s", (score, tierId) => {
    expect(getTier(score).id).toBe(tierId);
  });

  it("clamps scores to [-100, 100]", () => {
    expect(clampScore(180)).toBe(100);
    expect(clampScore(-180)).toBe(-100);
    expect(clampScore(42)).toBe(42);
  });

  it("names every tier in English and in Chinese, with a badge color", () => {
    for (const tier of AFFINITY_TIERS) {
      expect(tierLabel(undefined, tier.id)).toMatch(/^[A-Z][a-z]+$/);
      expect(tierLabel({ messages }, tier.id)).toMatch(/^[\u4e00-\u9fff]+$/);
      expect(tier.color).toBeTruthy();
    }
  });
});

// ── Tool unit tests ──────────────────────────────────────────────

describe("update-affinity", () => {
  const ctx = {
    sessionId: "sess-1",
    turnId: "turn-1",
    pluginId: "affinity",
    runtimeId: "affinity",
    locale: "zh-CN",
    messages,
    logicalTurn: 3,
  };
  let mockStore;
  let updateAffinityTool;

  beforeEach(async () => {
    mockStore = await createPluginTestStore(ctx);
    updateAffinityTool = bindToolStore(
      createUpdateAffinity({
        tool,
        z,
        shortIdBatch,
      }),
      mockStore,
    );
  });

  it("stores the tier label in the session's language", async () => {
    const result = await executeAndCommit(
      updateAffinityTool,
      { changes: [{ name: "Lian", delta: 5, reason: "You paid her debt" }] },
      { ...ctx, locale: "en-US", messages: undefined },
      mockStore,
    );
    const stored = await mockStore.getPluginData(
      "sess-1",
      "affinity",
      "affinity",
      getToolContent(result).results[0].id,
    );
    // The record goes into the prompt: one language, not a pair of both.
    expect(stored.value.tierLabel).toBe("Neutral");
  });

  it("creates an unknown NPC at score 0 and applies the delta with derived fields", async () => {
    const result = await executeAndCommit(
      updateAffinityTool,
      { changes: [{ name: "莉安", delta: 5, reason: "你替她挡了债主" }] },
      ctx,
      mockStore,
    );

    expect(getToolContent(result).applied).toBe(1);
    expect(getToolContent(result).results[0].status).toBe("created");
    const id = getToolContent(result).results[0].id;
    expect(id).toBeDefined();

    const stored = await mockStore.getPluginData(
      "sess-1",
      "affinity",
      "affinity",
      id,
    );
    expect(stored.value.name).toBe("莉安");
    expect(stored.value.score).toBe(5);
    expect(stored.value.scoreBar).toBe(105);
    expect(stored.value.tier).toBe("neutral");
    expect(stored.value.tierLabel).toBe("中立");
    expect(stored.value.history).toEqual([
      { turn: 3, delta: 5, reason: "你替她挡了债主" },
    ]);
  });

  it("accumulates onto an existing record and clamps at the +100 upper bound", async () => {
    await seedRecord(mockStore, "affinity-lian", {
      id: "affinity-lian",
      name: "莉安",
      score: 95,
      history: [],
    });

    const result = await executeAndCommit(
      updateAffinityTool,
      { changes: [{ name: "莉安", delta: 20, reason: "你救了她的命" }] },
      ctx,
      mockStore,
    );

    expect(getToolContent(result).results[0].status).toBe("updated");
    const stored = await mockStore.getPluginData(
      "sess-1",
      "affinity",
      "affinity",
      "affinity-lian",
    );
    expect(stored.value.score).toBe(100);
    expect(stored.value.tier).toBe("devoted");
    expect(stored.value.tierLabel).toBe("挚爱");
  });

  it("clamps at the -100 lower bound and lands in the hostile tier", async () => {
    await seedRecord(mockStore, "affinity-herman", {
      id: "affinity-herman",
      name: "赫尔曼",
      score: -90,
      history: [],
    });

    await executeAndCommit(
      updateAffinityTool,
      { changes: [{ name: "赫尔曼", delta: -20, reason: "你烧了他的哨所" }] },
      ctx,
      mockStore,
    );

    const stored = await mockStore.getPluginData(
      "sess-1",
      "affinity",
      "affinity",
      "affinity-herman",
    );
    expect(stored.value.score).toBe(-100);
    expect(stored.value.tier).toBe("hostile");
    expect(stored.value.tierLabel).toBe("敌视");
    expect(stored.value.lastDelta).toBe("-20");
    expect(stored.value.lastDeltaColor).toBe("red");
  });

  it("crosses a negative tier boundary from a delta", async () => {
    await seedRecord(mockStore, "affinity-herman", {
      id: "affinity-herman",
      name: "赫尔曼",
      score: -55,
      history: [],
    });

    await executeAndCommit(
      updateAffinityTool,
      { changes: [{ name: "赫尔曼", delta: -5, reason: "你再次戏弄了他" }] },
      ctx,
      mockStore,
    );

    const stored = await mockStore.getPluginData(
      "sess-1",
      "affinity",
      "affinity",
      "affinity-herman",
    );
    expect(stored.value.score).toBe(-60);
    expect(stored.value.tier).toBe("hostile");
  });

  it("keeps only the most recent 10 history entries", async () => {
    const oldHistory = Array.from({ length: 10 }, (_, i) => ({
      turn: i,
      delta: 1,
      reason: `旧记录 ${i}`,
    }));
    await seedRecord(mockStore, "affinity-lian", {
      id: "affinity-lian",
      name: "莉安",
      score: 10,
      history: oldHistory,
    });

    await executeAndCommit(
      updateAffinityTool,
      { changes: [{ name: "莉安", delta: 2, reason: "你陪她逛了集市" }] },
      ctx,
      mockStore,
    );

    const stored = await mockStore.getPluginData(
      "sess-1",
      "affinity",
      "affinity",
      "affinity-lian",
    );
    expect(stored.value.history).toHaveLength(10);
    // Oldest entry dropped, newest appended at the end.
    expect(stored.value.history[0]).toEqual(oldHistory[1]);
    expect(stored.value.history[9]).toEqual({
      turn: 3,
      delta: 2,
      reason: "你陪她逛了集市",
    });
  });

  it("backfills derived fields on a world-preseeded record without history/tier", async () => {
    // World-import shape: {id, name, score, notes?} — no derived fields.
    await seedRecord(mockStore, "aff-suwan", {
      id: "aff-suwan",
      name: "苏婉",
      score: 30,
      notes: "青梅竹马",
    });

    const result = await executeAndCommit(
      updateAffinityTool,
      { changes: [{ name: "苏婉", delta: 5, reason: "你记得她的生日" }] },
      ctx,
      mockStore,
    );

    // Matched by name — reuses the preseeded key instead of forking a record.
    expect(getToolContent(result).results[0]).toMatchObject({
      id: "aff-suwan",
      status: "updated",
    });

    const stored = await mockStore.getPluginData(
      "sess-1",
      "affinity",
      "affinity",
      "aff-suwan",
    );
    expect(stored.value.score).toBe(35);
    expect(stored.value.tier).toBe("friendly");
    expect(stored.value.tierLabel).toBe("友好");
    expect(stored.value.scoreBar).toBe(135);
    expect(stored.value.history).toEqual([
      { turn: 3, delta: 5, reason: "你记得她的生日" },
    ]);
    // Author notes survive the first tool write.
    expect(stored.value.notes).toBe("青梅竹马");
  });

  it("matches names case-insensitively instead of creating a duplicate", async () => {
    await seedRecord(mockStore, "aff-lian", {
      id: "aff-lian",
      name: "Lian",
      score: 10,
      history: [],
    });

    const result = await executeAndCommit(
      updateAffinityTool,
      { changes: [{ name: "lian", delta: 3, reason: "You walked her home" }] },
      ctx,
      mockStore,
    );

    expect(getToolContent(result).results[0]).toMatchObject({
      id: "aff-lian",
      status: "updated",
    });
    const records = (
      await mockStore.listPluginData("sess-1", "affinity", "affinity")
    ).filter((row) => row.namespace === "affinity");
    expect(records).toHaveLength(1);
    // The stored canonical casing wins over the LLM's casing.
    expect(records[0].value.name).toBe("Lian");
  });

  it("records a change addressed by an alias on the session character's one record", async () => {
    const world = {
      characters: [
        {
          id: "npc-keeper-ysolde",
          name: "Keeper Ysolde",
          aliases: ["Ysolde", "the Keeper"],
        },
      ],
    };
    await seedRecord(mockStore, "aff-ysolde", {
      id: "aff-ysolde",
      name: "Keeper Ysolde",
      score: 10,
      history: [],
    });

    const result = await executeAndCommit(
      updateAffinityTool,
      {
        changes: [
          { name: "the keeper", delta: 3, reason: "You relit her lantern" },
          { name: "ＹＳＯＬＤＥ", delta: 2, reason: "You kept her secret" },
        ],
      },
      { ...ctx, world },
      mockStore,
    );

    expect(getToolContent(result).results.map((r) => r.id)).toEqual([
      "aff-ysolde",
      "aff-ysolde",
    ]);
    const records = (
      await mockStore.listPluginData("sess-1", "affinity", "affinity")
    ).filter((row) => row.namespace === "affinity");
    expect(records).toHaveLength(1);
    expect(records[0].value).toMatchObject({
      name: "Keeper Ysolde",
      score: 15,
    });
  });

  it("names a new record after the session character, not after the alias used", async () => {
    const result = await executeAndCommit(
      updateAffinityTool,
      { changes: [{ name: "Wren", delta: 4, reason: "You shared bread" }] },
      {
        ...ctx,
        world: {
          characters: [
            { id: "npc-sister-wren", name: "Sister Wren", aliases: ["Wren"] },
          ],
        },
      },
      mockStore,
    );
    expect(getToolContent(result).results[0]).toMatchObject({
      name: "Sister Wren",
      status: "created",
    });
  });

  it("reads full-width letters and extra spaces as the same name", async () => {
    await seedRecord(mockStore, "aff-herman", {
      id: "aff-herman",
      name: "Captain Herman",
      score: 0,
      history: [],
    });

    const result = await executeAndCommit(
      updateAffinityTool,
      {
        changes: [
          {
            name: " Ｃａｐｔａｉｎ  Herman",
            delta: -3,
            reason: "You defied him",
          },
        ],
      },
      ctx,
      mockStore,
    );

    expect(getToolContent(result).results).toEqual([
      expect.objectContaining({ id: "aff-herman", status: "updated" }),
    ]);
  });

  it("accumulates duplicate names within one batched call in order", async () => {
    await executeAndCommit(
      updateAffinityTool,
      {
        changes: [
          { name: "莉安", delta: 5, reason: "你替她挡了债主" },
          { name: "莉安", delta: 3, reason: "你送她回家" },
        ],
      },
      ctx,
      mockStore,
    );

    const records = (
      await mockStore.listPluginData("sess-1", "affinity", "affinity")
    ).filter((row) => row.namespace === "affinity");
    expect(records).toHaveLength(1);
    expect(records[0].value.score).toBe(8);
    expect(records[0].value.history).toHaveLength(2);
  });

  it("writes this turn's changes into the message namespace for the toast block", async () => {
    await executeAndCommit(
      updateAffinityTool,
      { changes: [{ name: "莉安", delta: 5, reason: "你替她挡了债主" }] },
      ctx,
      mockStore,
    );

    const turnMarker = await mockStore.getPluginData(
      "sess-1",
      "affinity",
      "message",
      "__turnId",
    );
    expect(turnMarker.value).toBe("turn-1");

    const changes = await mockStore.getPluginData(
      "sess-1",
      "affinity",
      "message",
      "changes",
    );
    expect(changes.value).toHaveLength(1);
    expect(changes.value[0]).toMatchObject({
      name: "莉安",
      deltaText: "+5",
      deltaColor: "green",
      score: 5,
      reason: "你替她挡了债主",
    });
  });

  it("builds on same-turn pending writes before the turn commits", async () => {
    const first = await updateAffinityTool.execute(
      { changes: [{ name: "莉安", delta: 5, reason: "你替她挡了债主" }] },
      ctx,
    );
    const id = getToolContent(first).results[0].id;

    const second = await updateAffinityTool.execute(
      { changes: [{ name: "莉安", delta: 3, reason: "你送她回家" }] },
      { ...ctx, pendingProposals: getPendingProposals(first) },
    );

    // The second call saw the uncommitted score of 5, not a fresh record.
    expect(getToolContent(second).results[0]).toMatchObject({
      id,
      score: 8,
      status: "updated",
    });
  });
});

// ── Plugin manifest tests ────────────────────────────────────────

describe("affinity plugin manifest", () => {
  /** @type {import('@covel/shared').RuntimeManifest} */
  let manifest;
  let loaded;
  let declaration;
  let packageManifest;
  let loadedUi;

  beforeAll(async () => {
    const discoveries = await discoverPlugins(PLUGINS_DIR);
    const discovery = discoveries.find((d) => d.id === "affinity");
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

  it("is a non-core post-turn agent runtime gated on typed WorldIR", () => {
    expect(manifest.pluginType).toBe("plugin");
    expect(manifest.name).toBe("affinity");
    expect(manifest.stage).toBe("post-turn");
    expect(manifest.trigger?.type).toBe("auto");
    expect(manifest.needs).toBeUndefined();
    expect(manifest.inputs?.worldIR).toEqual({
      from: { capability: "world-ir-provider@1", cardinality: "one" },
      accepts: "contract:world-ir@1",
      required: true,
    });
    expect(declaration.requires).toContain("world-ir-provider@1");
    // Agent runtime — no `runtimeType` field means default 'agent'
    expect(manifest.runtimeType).toBe("agent");
    expect(manifest.handler).toBeUndefined();
  });

  it("injects existing affinity data without duplicating raw narrative", () => {
    const injects = manifest.input?.inject ?? [];
    expect(injects).toHaveLength(1);
    expect(injects).toContainEqual(
      expect.objectContaining({
        kind: "plugin-data",
        namespace: "affinity",
        as: "<existing-affinity>",
        format: "summary",
        maxEntries: 50,
      }),
    );
  });

  it("declares the update-affinity plugin tool via the entry module", () => {
    expect(manifest.tools?.plugin).toEqual(["update-affinity"]);
    expect(packageManifest.entry).toBe("./server/index.js");
    expect(manifest.completeAfterTools).toEqual(["update-affinity"]);
    expect(manifest.maxSteps).toBeUndefined(); // Inherit the framework budget.
    expect(manifest.maxRetries).toBe(3);
  });

  it("accepts world data into the affinity namespace via dataSchemas", () => {
    expect(packageManifest.dataSchemas?.affinity).toMatchObject({
      schemaVersion: 1,
      acceptsWorldData: true,
      schema: "./schemas/affinity.schema.json",
    });
  });

  it("declares right panel and message UI specs", () => {
    expect(packageManifest.ui?.right).toContain("./ui/affinity-panel.json");
    expect(packageManifest.ui?.message).toContain("./ui/affinity-toast.json");
  });

  it("loads UI spec JSON with panel metadata", () => {
    expect(loadedUi.uiSpecs?.right).toHaveLength(1);
    expect(loadedUi.uiSpecs?.right?.[0].id).toBe("affinity");
    expect(loadedUi.uiSpecs?.right?.[0].icon).toBe("heart");
    expect(loadedUi.uiSpecs?.message).toHaveLength(1);
    expect(loadedUi.uiSpecs?.message?.[0].id).toBe("affinity-toast");
  });

  it("loads PLUGIN.md body as the LLM prompt template", async () => {
    expect(loaded.promptTemplate).toContain("Affinity Tracker");
    expect(loaded.promptTemplate).toContain("<existing-affinity>");
    // A Chinese session reads the PLUGIN.zh.md variant of the same prompt.
    const discovery = (await discoverPlugins(PLUGINS_DIR)).find(
      (d) => d.id === "affinity",
    );
    const chinese = resolveRuntimePrompt(
      (await loadPluginDefinition(discovery, "zh-CN")).manifests[0],
      "zh-CN",
    );
    expect(chinese).toContain("好感度系统");
    expect(chinese).toContain("<existing-affinity>");
  });
});
