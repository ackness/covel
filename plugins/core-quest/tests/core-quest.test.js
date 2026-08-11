/**
 * core-quest plugin tests.
 *
 * Covers:
 *
 * 1. Local tool `upsert-quests` (L2): create with defaults, merge-by-name
 *    semantics, stable/semantic objective checklist matching, status transitions, the
 *    5-quest cap, world-pack preseeded records, and the message-namespace
 *    change summary — verified against an in-memory store stub.
 * 2. Plugin manifest: post-turn agent runtime shape, narrative-engine gate,
 *    dual-engine `input.inject` plus the plugin-data inject, `dataSchemas`
 *    world-data acceptance, and UI declarations.
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
import createUpsertQuests from "../tools/upsert-quests.js";

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

describe("upsert-quests", () => {
  const ctx = {
    sessionId: "sess-1",
    turnId: "turn-1",
    pluginId: "core-quest",
    runtimeId: "core-quest",
    turnNumber: 3,
  };
  let mockStore;
  let upsertQuestsTool;

  beforeEach(() => {
    mockStore = createMockPluginDataStore();
    upsertQuestsTool = createUpsertQuests({
      tool,
      z,
      shortIdBatch,
      store: mockStore,
    });
  });

  async function findQuestByName(name) {
    const rows = await mockStore.listPluginData(
      "sess-1",
      "core-quest",
      "quests",
    );
    return rows.find((row) => row.value.name === name) ?? null;
  }

  it("creates a new quest with defaults and derived chips", async () => {
    // Arrange
    const params = {
      quests: [
        {
          name: "寻回断魂钩",
          description: "神秘内门执事委托主角寻回失落的法器断魂钩。",
          objectives: [{ text: "潜入西侧旧药园" }, { text: "找到断魂钩" }],
          giver: "神秘内门执事",
          reward: "灵石百枚",
        },
      ],
    };

    // Act
    const result = await executeAndCommit(
      upsertQuestsTool,
      params,
      ctx,
      mockStore,
    );

    // Assert
    expect(result.upserted).toBe(1);
    expect(result.created).toBe(1);
    expect(result.quests[0].change).toBe("new");

    const stored = await findQuestByName("寻回断魂钩");
    expect(stored).not.toBeNull();
    expect(stored.value.status).toBe("active");
    expect(stored.value.isNew).toBe(true);
    expect(stored.value.updatedTurn).toBe(3);
    expect(stored.value.objectives).toEqual([
      { id: expect.any(String), text: "潜入西侧旧药园", done: false },
      { id: expect.any(String), text: "找到断魂钩", done: false },
    ]);
    expect(stored.value.chips).toEqual([
      "☐ 潜入西侧旧药园",
      "☐ 找到断魂钩",
      "⚑ 神秘内门执事",
      "✦ 灵石百枚",
    ]);
  });

  it("defaults description to an empty string so stored records match the import shape", async () => {
    // Arrange + Act
    await executeAndCommit(
      upsertQuestsTool,
      { quests: [{ name: "调查后山异常" }] },
      ctx,
      mockStore,
    );

    // Assert
    const stored = await findQuestByName("调查后山异常");
    expect(stored.value.description).toBe("");
    expect(stored.value.status).toBe("active");
  });

  it("merges by name: provided fields override, omitted fields keep their state", async () => {
    // Arrange
    await executeAndCommit(
      upsertQuestsTool,
      {
        quests: [
          {
            name: "寻回断魂钩",
            description: "原始描述。",
            giver: "神秘内门执事",
          },
        ],
      },
      ctx,
      mockStore,
    );

    // Act — same name, new reward, description omitted
    const result = await executeAndCommit(
      upsertQuestsTool,
      { quests: [{ name: "寻回断魂钩", reward: "灵石百枚" }] },
      ctx,
      mockStore,
    );

    // Assert — merged, not duplicated
    expect(result.advanced).toBe(1);
    expect(result.quests[0].change).toBe("progress");
    const rows = await mockStore.listPluginData(
      "sess-1",
      "core-quest",
      "quests",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].value.description).toBe("原始描述。");
    expect(rows[0].value.giver).toBe("神秘内门执事");
    expect(rows[0].value.reward).toBe("灵石百枚");
    expect(rows[0].value.isNew).toBe(false);
  });

  it("matches objectives by normalized text: known text checks done, new text appends", async () => {
    // Arrange
    await executeAndCommit(
      upsertQuestsTool,
      {
        quests: [
          {
            name: "调查后山异常",
            objectives: [{ text: "取得苏婉的协助" }, { text: "夜探后山" }],
          },
        ],
      },
      ctx,
      mockStore,
    );

    // Act — check one existing objective, append a new one
    await executeAndCommit(
      upsertQuestsTool,
      {
        quests: [
          {
            name: "调查后山异常",
            objectives: [
              { text: "取得苏婉的协助", done: true },
              { text: "查明灵脉异动来源" },
            ],
          },
        ],
      },
      ctx,
      mockStore,
    );

    // Assert
    const stored = await findQuestByName("调查后山异常");
    expect(stored.value.objectives).toEqual([
      { id: expect.any(String), text: "取得苏婉的协助", done: true },
      { id: expect.any(String), text: "夜探后山", done: false },
      { id: expect.any(String), text: "查明灵脉异动来源", done: false },
    ]);
    expect(stored.value.chips).toContain("✓ 取得苏婉的协助");
    expect(stored.value.chips).toContain("☐ 夜探后山");
  });

  it("does not uncheck a done objective when done is omitted on re-submit", async () => {
    // Arrange
    await executeAndCommit(
      upsertQuestsTool,
      {
        quests: [
          {
            name: "调查后山异常",
            objectives: [{ text: "取得苏婉的协助", done: true }],
          },
        ],
      },
      ctx,
      mockStore,
    );

    // Act — same objective text resubmitted without `done`
    await executeAndCommit(
      upsertQuestsTool,
      {
        quests: [
          { name: "调查后山异常", objectives: [{ text: "取得苏婉的协助" }] },
        ],
      },
      ctx,
      mockStore,
    );

    // Assert
    const stored = await findQuestByName("调查后山异常");
    expect(stored.value.objectives[0].done).toBe(true);
  });

  it("uses a stable objective id to merge rewritten text", async () => {
    await executeAndCommit(
      upsertQuestsTool,
      {
        quests: [
          {
            name: "未标注的泊点",
            objectives: [
              { id: "enter-black-tower", text: "缒链下降，进入黑色尖塔" },
            ],
          },
        ],
      },
      ctx,
      mockStore,
    );

    await executeAndCommit(
      upsertQuestsTool,
      {
        quests: [
          {
            name: "未标注的泊点",
            objectives: [
              { id: "enter-black-tower", text: "进入黑塔内部", done: true },
            ],
          },
        ],
      },
      ctx,
      mockStore,
    );

    const stored = await findQuestByName("未标注的泊点");
    expect(stored.value.objectives).toEqual([
      {
        id: "enter-black-tower",
        text: "缒链下降，进入黑色尖塔",
        done: true,
      },
    ]);
  });

  it("conservatively merges the observed expanded paraphrase without an id", async () => {
    await executeAndCommit(
      upsertQuestsTool,
      {
        quests: [
          {
            name: "未标注的泊点",
            objectives: [
              { text: "赶在封锚前备齐装具，完成下降准备" },
              { text: "缒链下降，进入黑色尖塔" },
              { text: "带回能解释玄负停驻的证物" },
            ],
          },
        ],
      },
      ctx,
      mockStore,
    );

    await executeAndCommit(
      upsertQuestsTool,
      {
        quests: [
          {
            name: "未标注的泊点",
            objectives: [{ text: "赶在封锚前挂链下降至沉城尖塔", done: true }],
          },
        ],
      },
      ctx,
      mockStore,
    );

    const stored = await findQuestByName("未标注的泊点");
    expect(stored.value.objectives).toHaveLength(3);
    expect(stored.value.objectives).toEqual([
      expect.objectContaining({
        text: "赶在封锚前备齐装具，完成下降准备",
        done: false,
      }),
      expect.objectContaining({
        text: "缒链下降，进入黑色尖塔",
        done: true,
      }),
      expect.objectContaining({
        text: "带回能解释玄负停驻的证物",
        done: false,
      }),
    ]);
  });

  it("heals semantically duplicated objectives already present in storage", async () => {
    await mockStore.setPluginData({
      id: "imported-record",
      sessionId: "sess-1",
      pluginId: "core-quest",
      namespace: "quests",
      key: "unmarked-mooring",
      value: {
        id: "unmarked-mooring",
        name: "未标注的泊点",
        description: "世界包预置任务",
        status: "active",
        objectives: [
          {
            id: "prepare-descent",
            text: "赶在封锚前备齐装具，完成下降准备",
            done: false,
          },
          {
            id: "enter-black-tower",
            text: "缒链下降，进入黑色尖塔",
            done: false,
          },
          {
            id: "objective-duplicate",
            text: "赶在封锚前挂链下降至沉城尖塔",
            done: true,
          },
          {
            id: "return-evidence",
            text: "带回能解释玄负停驻的证物",
            done: false,
          },
        ],
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await executeAndCommit(
      upsertQuestsTool,
      {
        quests: [
          {
            name: "未标注的泊点",
            objectives: [{ text: "进入黑塔内部", done: true }],
          },
        ],
      },
      ctx,
      mockStore,
    );

    const stored = await findQuestByName("未标注的泊点");
    expect(stored.value.objectives).toEqual([
      {
        id: "prepare-descent",
        text: "赶在封锚前备齐装具，完成下降准备",
        done: false,
      },
      {
        id: "enter-black-tower",
        text: "缒链下降，进入黑色尖塔",
        done: true,
      },
      {
        id: "return-evidence",
        text: "带回能解释玄负停驻的证物",
        done: false,
      },
    ]);
  });

  it("keeps similar but distinct objectives separate", async () => {
    await executeAndCommit(
      upsertQuestsTool,
      {
        quests: [
          {
            name: "塔内侦察",
            objectives: [{ text: "进入黑塔内部" }],
          },
        ],
      },
      ctx,
      mockStore,
    );

    await executeAndCommit(
      upsertQuestsTool,
      {
        quests: [
          {
            name: "塔内侦察",
            objectives: [{ text: "进入营地内部", done: true }],
          },
        ],
      },
      ctx,
      mockStore,
    );

    const stored = await findQuestByName("塔内侦察");
    expect(stored.value.objectives).toHaveLength(2);
    expect(stored.value.objectives.map((objective) => objective.text)).toEqual([
      "进入黑塔内部",
      "进入营地内部",
    ]);
  });

  it("classifies a status transition to completed / failed in the change summary", async () => {
    // Arrange
    await executeAndCommit(
      upsertQuestsTool,
      { quests: [{ name: "寻回断魂钩" }, { name: "护送商队" }] },
      ctx,
      mockStore,
    );

    // Act
    const result = await executeAndCommit(
      upsertQuestsTool,
      {
        quests: [
          { name: "寻回断魂钩", status: "completed" },
          { name: "护送商队", status: "failed" },
        ],
      },
      ctx,
      mockStore,
    );

    // Assert
    expect(result.quests.map((q) => q.change)).toEqual(["completed", "failed"]);
    const completed = await findQuestByName("寻回断魂钩");
    expect(completed.value.status).toBe("completed");
    const failed = await findQuestByName("护送商队");
    expect(failed.value.status).toBe("failed");
  });

  it("keeps a completed quest completed when status is omitted on a later update", async () => {
    // Arrange
    await executeAndCommit(
      upsertQuestsTool,
      { quests: [{ name: "寻回断魂钩", status: "completed" }] },
      ctx,
      mockStore,
    );

    // Act — a supplementary update without status must not regress it
    await executeAndCommit(
      upsertQuestsTool,
      { quests: [{ name: "寻回断魂钩", reward: "灵石百枚" }] },
      ctx,
      mockStore,
    );

    // Assert
    const stored = await findQuestByName("寻回断魂钩");
    expect(stored.value.status).toBe("completed");
  });

  it("rejects a call with more than 5 quests via parameter validation", async () => {
    // Arrange — zod caps the batch at 5; an oversized call must fail
    // validation (so the LLM retries smaller) instead of writing anything
    const params = {
      quests: Array.from({ length: 7 }, (_, i) => ({ name: `任务${i + 1}` })),
    };

    // Act + Assert
    await expect(
      executeAndCommit(upsertQuestsTool, params, ctx, mockStore),
    ).rejects.toThrow();
    const rows = await mockStore.listPluginData(
      "sess-1",
      "core-quest",
      "quests",
    );
    expect(rows).toHaveLength(0);
  });

  it("advances a world-pack preseeded record by name without duplicating it", async () => {
    // Arrange — simulate a worldData import (row key differs from a tool id)
    await mockStore.setPluginData({
      id: "imported-record",
      sessionId: "sess-1",
      pluginId: "core-quest",
      namespace: "quests",
      key: "main-quest-01",
      value: {
        id: "main-quest-01",
        name: "调查后山异常",
        description: "世界包预置的主线任务。",
        status: "active",
        objectives: [{ text: "夜探后山" }],
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Act
    const result = await executeAndCommit(
      upsertQuestsTool,
      {
        quests: [
          {
            name: "调查后山异常",
            objectives: [{ text: "夜探后山", done: true }],
          },
        ],
      },
      ctx,
      mockStore,
    );

    // Assert — merged onto the imported row key, no duplicate
    expect(result.advanced).toBe(1);
    const rows = await mockStore.listPluginData(
      "sess-1",
      "core-quest",
      "quests",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("main-quest-01");
    expect(rows[0].value.description).toBe("世界包预置的主线任务。");
    expect(rows[0].value.objectives).toEqual([
      { id: expect.any(String), text: "夜探后山", done: true },
    ]);
  });

  it("writes this turn's change summary into the message namespace", async () => {
    // Arrange + Act
    await executeAndCommit(
      upsertQuestsTool,
      {
        quests: [
          {
            name: "寻回断魂钩",
            objectives: [
              { text: "潜入西侧旧药园", done: true },
              { text: "找到断魂钩" },
            ],
          },
        ],
      },
      ctx,
      mockStore,
    );

    // Assert
    const turnId = await mockStore.getPluginData(
      "sess-1",
      "core-quest",
      "message",
      "__turnId",
    );
    expect(turnId.value).toBe("turn-1");

    const changes = await mockStore.getPluginData(
      "sess-1",
      "core-quest",
      "message",
      "changes",
    );
    expect(changes.value).toHaveLength(1);
    expect(changes.value[0]).toMatchObject({
      name: "寻回断魂钩",
      change: "new",
      badge: { zh: "新任务", en: "New" },
      color: "blue",
      detail: "1/2",
    });
  });

  it("merges two same-name entries within one call instead of duplicating", async () => {
    // Arrange + Act
    await executeAndCommit(
      upsertQuestsTool,
      {
        quests: [
          { name: "寻回断魂钩", objectives: [{ text: "潜入西侧旧药园" }] },
          { name: "寻回断魂钩", objectives: [{ text: "找到断魂钩" }] },
        ],
      },
      ctx,
      mockStore,
    );

    // Assert — one row carrying both objectives
    const rows = await mockStore.listPluginData(
      "sess-1",
      "core-quest",
      "quests",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].value.objectives.map((o) => o.text)).toEqual([
      "潜入西侧旧药园",
      "找到断魂钩",
    ]);
  });
});

// ── Plugin manifest tests ────────────────────────────────────────

describe("core-quest plugin manifest", () => {
  /** @type {import('@covel/shared').RuntimeManifest} */
  let manifest;
  let loaded;

  beforeAll(async () => {
    const discoveries = await discoverPlugins(PLUGINS_DIR);
    const discovery = discoveries.find((d) => d.id === "core-quest");
    const manifests = await loadPluginManifest(discovery);
    manifest = manifests[0].manifest;
    loaded = await loadRuntime(discovery, manifest.name);
  });

  it("is a non-core post-turn agent runtime gated on the narrative engine", () => {
    expect(manifest.pluginType).toBe("plugin");
    expect(manifest.name).toBe("core-quest");
    expect(manifest.stage).toBe("post-turn");
    // Agent runtime — no `runtimeType` field means default 'agent'
    expect(manifest.runtimeType).toBeUndefined();
    expect(manifest.handler).toBeUndefined();
    expect(manifest.trigger?.type).toBe("auto");
    expect(manifest.needs).toEqual([{ capability: "narrative-engine" }]);
  });

  it("declares both narrative-engine runtime injects and the plugin-data inject", () => {
    const injects = manifest.input?.inject ?? [];
    expect(injects).toHaveLength(3);

    // Engine-agnostic: one runtime inject per known narrative engine; the
    // absent engine resolves to nothing so exactly the active one fills
    // the <narrator-output> block.
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
        namespace: "quests",
        as: "<existing-quests>",
        format: "summary",
        maxEntries: 50,
      }),
    );
  });

  it("declares the upsert-quests plugin tool via the entry module", () => {
    expect(manifest.entry).toBe("./server/index.js");
    expect(manifest.tools?.plugin).toEqual(["upsert-quests"]);
  });

  it("accepts world-data imports into the quests namespace", () => {
    expect(manifest.dataSchemas?.quests).toMatchObject({
      schemaVersion: 1,
      acceptsWorldData: true,
      schema: "./schemas/quests.schema.json",
    });
  });

  it("declares right panel and message block UI specs", () => {
    expect(manifest.ui?.right).toContain("./ui/quest-log-panel.json");
    expect(manifest.ui?.message).toContain("./ui/quest-changes-block.json");
  });

  it("loads UI spec JSON with panel metadata", () => {
    expect(loaded.uiSpecs?.right).toHaveLength(1);
    expect(loaded.uiSpecs?.right?.[0].id).toBe("core-quest");
    expect(loaded.uiSpecs?.right?.[0].icon).toBe("scroll-text");
    expect(loaded.uiSpecs?.message).toHaveLength(1);
    expect(loaded.uiSpecs?.message?.[0].id).toBe("core-quest-changes");
  });

  it("loads PLUGIN.md body as the LLM prompt template", () => {
    expect(loaded.promptTemplate).toContain("任务日志");
    expect(loaded.promptTemplate).toContain("<existing-quests>");
  });
});
