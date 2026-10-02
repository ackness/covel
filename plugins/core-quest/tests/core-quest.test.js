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
 * core-quest plugin tests.
 *
 * Covers:
 *
 * 1. Local tool `upsert-quests` (L2): create with defaults, merge-by-name
 *    semantics, stable/semantic objective checklist matching, status transitions, the
 *    5-quest cap, world-pack preseeded records, and the message-namespace
 *    change summary — verified against the real in-memory store and commit boundary.
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
  loadPluginDefinition,
  loadPluginUi,
  loadRuntime,
} from "@covel/plugin-loader";

import { tool, z } from "@covel/tools";
import createUpsertQuests from "../lib/upsert-quests.js";
import { questUpdatesFromWorldIR, resolveQuestName } from "../lib/world-ir.js";
import questLog from "../runtimes/log/handler.js";
import vocabulary from "../runtimes/vocabulary/handler.js";

const PLUGINS_DIR = path.resolve(import.meta.dirname, "../..");

// ── Tool unit tests ──────────────────────────────────────────────

describe("upsert-quests", () => {
  const ctx = {
    sessionId: "sess-1",
    turnId: "turn-1",
    pluginId: "core-quest",
    runtimeId: "core-quest/log",
    logicalTurn: 3,
  };
  let mockStore;
  let upsertQuestsTool;

  beforeEach(async () => {
    mockStore = await createPluginTestStore(ctx);
    upsertQuestsTool = bindToolStore(
      createUpsertQuests({
        tool,
        z,
        shortIdBatch,
      }),
      mockStore,
    );
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
    expect(getToolContent(result).upserted).toBe(1);
    expect(getToolContent(result).created).toBe(1);
    expect(getToolContent(result).quests[0].change).toBe("new");

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
    expect(getToolContent(result).advanced).toBe(1);
    expect(getToolContent(result).quests[0].change).toBe("progress");
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

  it("keeps distinct English objectives apart and matches paraphrases by words", async () => {
    await mockStore.setPluginData({
      id: "imported-call",
      sessionId: "sess-1",
      pluginId: "core-quest",
      namespace: "quests",
      key: "call-from-tomorrow",
      value: {
        id: "call-from-tomorrow",
        name: "The Call from Tomorrow",
        status: "active",
        objectives: [
          {
            id: "preserve-recording",
            text: "Make an isolated copy of the future transmission",
            done: false,
          },
          {
            id: "compare-voiceprint",
            text: "Compare the signal against your station voiceprint",
            done: false,
          },
          {
            id: "trace-echo",
            text: "Trace the echo's time and location signature",
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
            name: "The Call from Tomorrow",
            objectives: [
              {
                text: "Compare the signal with the station voiceprint",
                done: true,
              },
            ],
          },
        ],
      },
      ctx,
      mockStore,
    );

    const stored = await findQuestByName("The Call from Tomorrow");
    expect(stored.value.objectives.map(({ id, done }) => [id, done])).toEqual([
      ["preserve-recording", false],
      ["compare-voiceprint", true],
      ["trace-echo", false],
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
    expect(getToolContent(result).quests.map((q) => q.change)).toEqual([
      "completed",
      "failed",
    ]);
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
    expect(getToolContent(result).advanced).toBe(1);
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
  let vocabularyManifest;
  let loaded;
  let declaration;
  let packageManifest;
  let loadedUi;

  beforeAll(async () => {
    const discoveries = await discoverPlugins(PLUGINS_DIR);
    const discovery = discoveries.find((d) => d.id === "core-quest");
    const definition = await loadPluginDefinition(discovery);
    const manifests = definition.manifests;
    packageManifest = definition.packageManifest.manifest;
    loadedUi = await loadPluginUi(discovery, undefined, definition);
    manifest = manifests.find(
      (entry) => entry.manifest.name === "core-quest/log",
    ).manifest;
    vocabularyManifest = manifests.find(
      (entry) => entry.manifest.name === "core-quest/vocabulary",
    ).manifest;
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

  it("keeps the log in a post-turn function runtime gated on typed WorldIR", () => {
    expect(manifest.pluginType).toBe("plugin");
    expect(manifest.stage).toBe("post-turn");
    expect(manifest.runtimeType).toBe("function");
    expect(manifest.handler).toBe("./handler.js");
    expect(manifest.tools).toBeUndefined();
    expect(manifest.trigger?.type).toBe("auto");
    expect(manifest.needs).toBeUndefined();
    expect(manifest.inputs?.worldIR).toEqual({
      from: { capability: "world-ir-provider@1", cardinality: "one" },
      accepts: "contract:world-ir@1",
      required: true,
    });
    expect(declaration.requires).toContain("world-ir-provider@1");
    expect(packageManifest.entry).toBeUndefined();
    expect(loaded.handler).toBeTypeOf("function");
  });

  it("publishes the quest vocabulary before the narrative", () => {
    expect(vocabularyManifest).toMatchObject({
      runtimeType: "function",
      stage: "pre-turn",
      outputContract: "world-ir.vocabulary@1",
    });
    expect(declaration.provides).toContain("world-ir.vocabulary@1");
  });

  it("accepts world-data imports into the quests namespace", () => {
    expect(packageManifest.dataSchemas?.quests).toMatchObject({
      schemaVersion: 1,
      acceptsWorldData: true,
      schema: "./schemas/quests.schema.json",
    });
  });

  it("declares right panel and message block UI specs", () => {
    expect(packageManifest.ui?.right).toContain("./ui/quest-log-panel.json");
    expect(packageManifest.ui?.message).toContain(
      "./ui/quest-changes-block.json",
    );
  });

  it("loads UI spec JSON with panel metadata", () => {
    expect(loadedUi.uiSpecs?.right).toHaveLength(1);
    expect(loadedUi.uiSpecs?.right?.[0].id).toBe("core-quest");
    expect(loadedUi.uiSpecs?.right?.[0].icon).toBe("scroll-text");
    expect(loadedUi.uiSpecs?.message).toHaveLength(1);
    expect(loadedUi.uiSpecs?.message?.[0].id).toBe("core-quest-changes");
  });
});

// ── WorldIR mapping, log and vocabulary ──────────────────────────

describe("quests from WorldIR", () => {
  const worldIR = (events) => ({
    schemaVersion: 1,
    entities: [],
    relations: [],
    events,
    statements: [],
  });
  const quest = (attributes, description) => ({
    id: `quest-${attributes.status}-${attributes.quest}`,
    type: "quest_change",
    ...(description ? { description } : {}),
    attributes,
  });

  it("resolves names exactly first, then by a unique containment", () => {
    const known = ["The Call from Tomorrow", "Stop the Convoy"];
    expect(resolveQuestName("the call from tomorrow", known)).toBe(
      "The Call from Tomorrow",
    );
    expect(resolveQuestName("Convoy", known)).toBe("Stop the Convoy");
    expect(resolveQuestName("the", ["The Call", "The Convoy"])).toBeUndefined();
  });

  it("creates only explicitly accepted quests and advances known ones", () => {
    const updates = questUpdatesFromWorldIR(
      worldIR([
        quest(
          {
            quest: "Find the keeper",
            status: "accepted",
            objectives: ["Ask at the pier"],
            giver: "Mira",
          },
          "Mira asks you to find the missing keeper.",
        ),
        quest({
          quest: "Find the keeper",
          status: "progressed",
          completedObjectives: ["Ask at the pier"],
        }),
        quest({ quest: "stop the convoy", status: "completed" }),
        quest({ quest: "A rumor about gold", status: "progressed" }),
        quest({ quest: "Stop the Convoy", status: "toString" }),
      ]),
      ["Stop the Convoy"],
    );
    expect(updates).toEqual([
      {
        name: "Find the keeper",
        description: "Mira asks you to find the missing keeper.",
        objectives: [{ text: "Ask at the pier" }],
        giver: "Mira",
      },
      {
        name: "Find the keeper",
        objectives: [{ text: "Ask at the pier", done: true }],
      },
      { name: "Stop the Convoy", status: "completed" },
    ]);
  });

  it("writes the updates through the log without a model call", async () => {
    const result = await questLog({
      sessionId: "sess-1",
      turnId: "turn-1",
      pluginId: "core-quest",
      runtimeId: "core-quest/log",
      logicalTurn: 2,
      store: {
        listPluginData: async () => [],
        getPluginData: async () => null,
      },
      inputs: {
        worldIR: {
          value: worldIR([
            quest({
              quest: "Find the keeper",
              status: "accepted",
              objectives: ["Ask at the pier"],
            }),
          ]),
        },
      },
    });

    expect(getToolContent(result)).toMatchObject({
      outcome: "success",
      value: { created: 1 },
    });
    const [proposal] = getPendingProposals(result);
    expect(proposal.payload.items).toContainEqual(
      expect.objectContaining({
        namespace: "quests",
        value: expect.objectContaining({
          name: "Find the keeper",
          status: "active",
        }),
      }),
    );
  });

  it("publishes active quests with their open objectives", async () => {
    const result = await vocabulary({
      store: {
        listPluginData: async () => [
          {
            key: "q1",
            value: {
              name: "Find the keeper",
              status: "active",
              objectives: [
                { id: "o1", text: "Ask at the pier", done: true },
                { id: "o2", text: "Search the lighthouse", done: false },
              ],
            },
          },
          { key: "q2", value: { name: "Old errand", status: "completed" } },
        ],
      },
    });
    expect(result).toEqual({
      outcome: "success",
      value: {
        entries: [
          {
            type: "quest",
            name: "Find the keeper",
            details: ["Search the lighthouse"],
          },
        ],
      },
    });
  });
});
