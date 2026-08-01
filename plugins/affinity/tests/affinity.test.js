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
  loadPluginManifest,
  loadRuntime,
} from "@covel/plugin-loader";
import { getPendingProposals, tool, z, shortIdBatch } from "@covel/tools";
import createUpdateAffinity from "../tools/update-affinity.js";
import { AFFINITY_TIERS, clampScore, getTier } from "../tier-metadata.js";

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

/** Seed a committed affinity record directly into the mock store. */
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

  it("carries a bilingual label and a badge color on every tier", () => {
    for (const tier of AFFINITY_TIERS) {
      expect(tier.label.zh).toBeTruthy();
      expect(tier.label.en).toBeTruthy();
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
    turnNumber: 3,
  };
  let mockStore;
  let updateAffinityTool;

  beforeEach(() => {
    mockStore = createMockPluginDataStore();
    updateAffinityTool = createUpdateAffinity({
      tool,
      z,
      shortIdBatch,
      store: mockStore,
    });
  });

  it("creates an unknown NPC at score 0 and applies the delta with derived fields", async () => {
    const result = await executeAndCommit(
      updateAffinityTool,
      { changes: [{ name: "莉安", delta: 5, reason: "你替她挡了债主" }] },
      ctx,
      mockStore,
    );

    expect(result.applied).toBe(1);
    expect(result.results[0].status).toBe("created");
    const id = result.results[0].id;
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
    expect(stored.value.tierLabel).toEqual({ zh: "中立", en: "Neutral" });
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

    expect(result.results[0].status).toBe("updated");
    const stored = await mockStore.getPluginData(
      "sess-1",
      "affinity",
      "affinity",
      "affinity-lian",
    );
    expect(stored.value.score).toBe(100);
    expect(stored.value.tier).toBe("devoted");
    expect(stored.value.tierLabel).toEqual({ zh: "挚爱", en: "Devoted" });
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
    expect(stored.value.tierLabel).toEqual({ zh: "敌视", en: "Hostile" });
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
    expect(result.results[0]).toMatchObject({
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
    expect(stored.value.tierLabel).toEqual({ zh: "友好", en: "Friendly" });
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

    expect(result.results[0]).toMatchObject({
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
    const id = first.results[0].id;

    const second = await updateAffinityTool.execute(
      { changes: [{ name: "莉安", delta: 3, reason: "你送她回家" }] },
      { ...ctx, pendingProposals: getPendingProposals(first) },
    );

    // The second call saw the uncommitted score of 5, not a fresh record.
    expect(second.results[0]).toMatchObject({
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

  beforeAll(async () => {
    const discoveries = await discoverPlugins(PLUGINS_DIR);
    const discovery = discoveries.find((d) => d.id === "affinity");
    const manifests = await loadPluginManifest(discovery);
    manifest = manifests[0].manifest;
    loaded = await loadRuntime(discovery, manifest.name);
  });

  it("is a non-core post-turn agent runtime gated on the narrative engine", () => {
    expect(manifest.pluginType).toBe("plugin");
    expect(manifest.name).toBe("affinity");
    expect(manifest.stage).toBe("post-turn");
    expect(manifest.trigger?.type).toBe("auto");
    expect(manifest.needs).toEqual([{ capability: "narrative-engine" }]);
    // Agent runtime — no `runtimeType` field means default 'agent'
    expect(manifest.runtimeType).toBeUndefined();
    expect(manifest.handler).toBeUndefined();
  });

  it("declares both narrative-engine runtime injects and the plugin-data inject", () => {
    const injects = manifest.input?.inject ?? [];
    expect(injects).toHaveLength(3);

    for (const engine of ["narrator", "chat-mode-narrator"]) {
      expect(injects).toContainEqual({
        kind: "runtime",
        from: engine,
        field: "narrativeOutput",
        as: "<narrator-output>",
      });
    }

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
    expect(manifest.entry).toBe("./server/index.js");
  });

  it("accepts world data into the affinity namespace via dataSchemas", () => {
    expect(manifest.dataSchemas?.affinity).toMatchObject({
      schemaVersion: 1,
      acceptsWorldData: true,
      schema: "./schemas/affinity.schema.json",
    });
  });

  it("declares right panel and message UI specs", () => {
    expect(manifest.ui?.right).toContain("./ui/affinity-panel.json");
    expect(manifest.ui?.message).toContain("./ui/affinity-toast.json");
  });

  it("loads UI spec JSON with panel metadata", () => {
    expect(loaded.uiSpecs?.right).toHaveLength(1);
    expect(loaded.uiSpecs?.right?.[0].id).toBe("affinity");
    expect(loaded.uiSpecs?.right?.[0].icon).toBe("heart");
    expect(loaded.uiSpecs?.message).toHaveLength(1);
    expect(loaded.uiSpecs?.message?.[0].id).toBe("affinity-toast");
  });

  it("loads PLUGIN.md body as the LLM prompt template", () => {
    expect(loaded.promptTemplate).toContain("好感度系统");
    expect(loaded.promptTemplate).toContain("<existing-affinity>");
  });
});
