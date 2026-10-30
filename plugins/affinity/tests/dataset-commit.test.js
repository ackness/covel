import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverPlugins,
  loadPluginManifest,
  loadRuntime,
} from "@covel/plugin-loader";
import { createMemoryStore } from "@covel/store/memory";
import {
  executeTurn,
  commitExecution,
  createToolExecutor,
} from "@covel/runtime";
import {
  applyDataOps,
  getPendingProposals,
  getToolContent,
  makeProposal,
  withPendingProposals,
  shortIdBatch,
} from "@covel/plugin-handlers-utils";
import { tool, z, validateOutput } from "@covel/tools";
import createUpdateAffinity from "../tools/update-affinity.js";

const schema = JSON.parse(
  readFileSync(
    new URL("../schemas/affinity.schema.json", import.meta.url),
    "utf8",
  ),
);
const examples = JSON.parse(
  readFileSync(new URL("../examples/affinity.json", import.meta.url), "utf8"),
);
const worldIRSchema = JSON.parse(
  readFileSync(
    new URL("../../world-ir/schemas/world-ir.schema.json", import.meta.url),
    "utf8",
  ),
);
const now = "2026-09-18T00:00:00Z";
const sessionId = "affinity-dataset";
const initialRecord = {
  id: "npc",
  name: "NPC",
  score: 10,
  notes: "Author note",
};
const defaultChanges = [
  { name: "NPC", delta: 5, reason: "Helped" },
  { name: "NPC", delta: 3, reason: "Shared bread" },
  { name: "Lian", delta: 20, reason: "Saved her life" },
];

async function loadTracker() {
  const discovery = (
    await discoverPlugins(path.resolve(import.meta.dirname, "../.."))
  ).find((entry) => entry.id === "affinity");
  const [parsed] = await loadPluginManifest(discovery);
  return loadRuntime(discovery, parsed.manifest.name, undefined, undefined, {
    "world-ir@1": worldIRSchema,
  });
}

async function fixture(invalidWrite) {
  const store = createMemoryStore();
  await store.createSession({
    id: sessionId,
    locale: "en",
    status: "active",
    phase: "playing",
    setupRuntimes: {},
    seats: [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
    completedPlayerTurns: 0,
    activePlugins: ["affinity", "story", "facts"],
    createdAt: now,
    updatedAt: now,
  });
  await store.setPluginData({
    id: "seed",
    sessionId,
    pluginId: "affinity",
    namespace: "affinity",
    key: "npc",
    value: initialRecord,
    createdAt: now,
    updatedAt: now,
  });
  const tracker = await loadTracker();
  const loaded = new Map([[tracker.manifest.name, tracker]]);
  const story = {
    name: "story",
    pluginId: "story",
    stage: "narrative",
    runtimeType: "function",
    outputKind: "story",
    outputContract: "narrative-engine@2",
    trigger: { type: "auto" },
  };
  loaded.set(story.name, {
    manifest: story,
    promptTemplate: "",
    handler: async (ctx) =>
      withPendingProposals(
        {
          outcome: "success",
          value: { narrativeOutput: "You help NPC and Lian." },
        },
        [
          makeProposal(ctx, now, "plugin.data", {
            namespace: "saved",
            key: ctx.turnId,
            value: "Story preserved",
          }),
        ],
      ),
  });
  const facts = {
    name: "facts",
    pluginId: "facts",
    stage: "post-turn",
    runtimeType: "function",
    outputKind: "system",
    outputContract: "world-ir-provider@1",
    trigger: { type: "auto" },
    inputs: {
      narrative: {
        from: { capability: "narrative-engine@2", cardinality: "one" },
        required: true,
      },
    },
  };
  loaded.set(facts.name, {
    manifest: facts,
    promptTemplate: "",
    outputSchema: worldIRSchema,
    handler: async () => ({
      outcome: "success",
      value: {
        schemaVersion: 1,
        entities: [],
        relations: [],
        events: [],
        statements: [],
      },
    }),
  });
  const update = createUpdateAffinity({ tool, z, shortIdBatch });
  const execute = update.execute;
  const recorded = [];
  let rejected;
  update.execute = async (params, ctx) => {
    const result = await execute(params, ctx);
    recorded.push(result);
    if (!invalidWrite) return result;
    rejected = makeProposal(ctx, now, "plugin.data", {
      namespace: "affinity",
      key: "npc",
      value: { id: "npc", name: "NPC", score: invalidWrite },
    });
    return withPendingProposals(getToolContent(result), [
      ...getPendingProposals(result),
      rejected,
    ]);
  };
  const run = (changes = defaultChanges, turnId = "turn") =>
    executeTurn(
      {
        sessionId,
        turnId,
        origin: "player",
        playerMessage: "Help them.",
        locale: "en",
      },
      [story, facts, tracker.manifest],
      {
        store,
        getPluginSource: () => "builtin",
        loadRuntime: async (manifest) => loaded.get(manifest.name),
        llm: {
          generate: async () => ({
            content: null,
            toolCalls: [
              {
                id: "update",
                name: update.name,
                arguments: JSON.stringify({ changes }),
              },
            ],
            finishReason: "tool_calls",
            usage: { inputTokens: 1, outputTokens: 1 },
          }),
        },
        toolExecutor: createToolExecutor({
          store,
          findTool: (name) => (name === update.name ? update : undefined),
        }),
      },
    );
  const commit = (execution) =>
    commitExecution({
      store,
      execution,
      completion: {
        kind: "turn",
        turnId: execution.result.turnId,
        durationMs: 1,
      },
    });
  return { store, tracker, recorded, run, commit, rejected: () => rejected };
}

describe("affinity dataset", () => {
  it("loads the real manifest dataset and its shared import schema", async () => {
    const loaded = await loadTracker();
    expect(loaded.manifest.datasets.affinity).toEqual({
      namespace: "affinity",
      schema: "./schemas/affinity.schema.json",
      key: "id",
      ops: ["set", "merge", "inc"],
    });
    expect(loaded.datasetSchemas.affinity).toEqual(schema);
  });

  it("accepts every world-seeded example", () => {
    for (const value of examples)
      expect(validateOutput(value, schema).valid).toBe(true);
  });

  it.each([-101, 101, "unknown"])(
    "rejects a score outside the dataset schema: %s",
    (score) => {
      expect(
        validateOutput({ id: "npc", name: "NPC", score }, schema).valid,
      ).toBe(false);
    },
  );

  it("commits the real tool's operations and matches the old backfilled record values", async () => {
    const { store, tracker, recorded, run, commit } = await fixture();
    expect(tracker.datasetSchemas.affinity).toEqual(schema);
    const execution = await run();
    expect(
      execution.result.runtimeResults.map((entry) => [
        entry.runtimeId,
        entry.status,
      ]),
    ).toEqual([
      ["story", "success"],
      ["facts", "success"],
      ["affinity", "success"],
    ]);
    expect(
      (await store.getPluginData(sessionId, "affinity", "affinity", "npc"))
        .value,
    ).toEqual(initialRecord);
    const result = recorded[0];
    expect(getToolContent(result).applied).toBe(3);
    const updates = getPendingProposals(result).filter(
      (proposal) => proposal.type === "plugin.data.update",
    );
    expect(updates).toHaveLength(2);
    expect(updates[0].payload.ops.map((op) => op.op)).toEqual([
      "inc",
      "merge",
      "inc",
      "merge",
    ]);
    expect(updates[1].payload.ops.map((op) => op.op)).toEqual(["set"]);
    const outcome = await commit(execution);
    expect(outcome.status).toBe("committed");
    expect(outcome.failedProposals).toEqual([]);
    expect(outcome.isolatedRuntimes ?? []).toEqual([]);
    for (const proposal of updates) {
      const { key, ops } = proposal.payload;
      const existing = key === "npc";
      const expected = {
        ...(existing ? initialRecord : { id: key, name: "Lian" }),
        score: existing ? 18 : 20,
        scoreBar: existing ? 118 : 120,
        tier: existing ? "neutral" : "friendly",
        tierLabel: existing ? "Neutral" : "Friendly",
        tierColor: existing ? "amber" : "green",
        lastDelta: existing ? "+3" : "+20",
        lastDeltaColor: "green",
        lastReason: existing ? "Shared bread" : "Saved her life",
        history: existing
          ? [
              { turn: 1, delta: 5, reason: "Helped" },
              { turn: 1, delta: 3, reason: "Shared bread" },
            ]
          : [{ turn: 1, delta: 20, reason: "Saved her life" }],
        updatedAt: proposal.timestamp,
      };
      expect(
        applyDataOps(
          existing ? { exists: true, value: initialRecord } : { exists: false },
          ops,
        ),
      ).toEqual({ ok: true, exists: true, value: expected });
      expect(
        (await store.getPluginData(sessionId, "affinity", "affinity", key))
          .value,
      ).toEqual(expected);
    }
    expect(
      (await store.getPluginData(sessionId, "affinity", "message", "changes"))
        .value,
    ).toHaveLength(3);
  });

  it.each([-101, 101])(
    "refuses score %i and rolls back only the affinity unit",
    async (score) => {
      const { store, recorded, run, commit, rejected } = await fixture(score);
      const execution = await run();
      expect(getToolContent(recorded[0]).applied).toBe(3);
      expect(
        execution.result.runtimeResults.find(
          (entry) => entry.runtimeId === "affinity",
        ).status,
      ).toBe("success");
      const outcome = await commit(execution);
      expect(outcome.status).toBe("committed");
      expect(outcome.failedProposals).toEqual([
        expect.objectContaining({
          proposal: rejected(),
          code: "dataset-violation",
        }),
      ]);
      expect(outcome.isolatedRuntimes.map((entry) => entry.runtimeId)).toEqual([
        "affinity",
      ]);
      expect(
        (await store.listPluginData(sessionId, "affinity", "affinity")).map(
          (row) => row.value,
        ),
      ).toEqual([initialRecord]);
      expect(
        await store.listPluginData(sessionId, "affinity", "message"),
      ).toEqual([]);
      expect(
        (await store.getPluginData(sessionId, "story", "saved", "turn")).value,
      ).toBe("Story preserved");
      const [saved] = await store.queryTurnResults(sessionId, {
        turnId: "turn",
        commitStatus: "committed",
      });
      expect(
        saved.runtimeResults.find((entry) => entry.runtimeId === "story")
          .status,
      ).toBe("success");
    },
  );

  it("adds both stale-read deltas under the real dataset while keeping the last predicted display and history", async () => {
    const { store, recorded, run, commit } = await fixture();
    // Both executions read score 10 before either one commits.
    const first = await run(
      [{ name: "NPC", delta: 15, reason: "Helped" }],
      "first",
    );
    const second = await run(
      [{ name: "NPC", delta: -5, reason: "Argued" }],
      "second",
    );
    expect(getToolContent(recorded[0]).results[0].score).toBe(25);
    expect(getToolContent(recorded[1]).results[0].score).toBe(5);
    for (const execution of [first, second]) {
      const outcome = await commit(execution);
      expect(outcome.status).toBe("committed");
      expect(outcome.failedProposals).toEqual([]);
    }
    const value = (
      await store.getPluginData(sessionId, "affinity", "affinity", "npc")
    ).value;
    expect(value).toMatchObject({
      score: 20,
      scoreBar: 105,
      tier: "neutral",
      lastReason: "Argued",
      notes: "Author note",
    });
    // Neither execution advanced completedPlayerTurns before these histories
    // were predicted, so both stamps are logical turn 1.
    expect(value.history).toEqual([{ turn: 1, delta: -5, reason: "Argued" }]);
    expect(value.scoreBar).not.toBe(value.score + 100);
    expect(
      getPendingProposals(recorded[1])[0].payload.ops.map((op) => op.op),
    ).toEqual(["inc", "merge"]);
  });
});
