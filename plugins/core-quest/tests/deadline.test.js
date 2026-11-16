import { describe, expect, it } from "vitest";
import {
  getPendingProposals,
  getToolContent,
} from "@covel/plugin-handlers-utils";
import {
  bindToolStore,
  commitToolResults,
  createPluginTestStore,
  loadPluginMessages,
  makeRandom,
} from "@covel/plugin-test-utils";
import deadline from "../runtimes/deadline/handler.js";
import upsertQuests from "../lib/upsert-quests.js";
import vocabulary from "../runtimes/vocabulary/handler.js";

const messages = await loadPluginMessages(new URL("..", import.meta.url), "en");

// Listed in key order, as the store returns them. A main quest with a time limit, and a side quest whose objective must be
// done before the water rises.
const seeded = [
  {
    id: "reach-theo",
    name: "The three who walked",
    description: "Catch up with the three who walked ahead.",
    status: "active",
    deadline: {
      when: { time: "elapsedSinceStart", gte: 45 },
      label: "Before their lamps are out of sight",
      missed: "The lamps ahead are gone; you walk on alone.",
    },
    objectives: [{ id: "follow", text: "Follow the lamps", done: false }],
  },
  {
    id: "one-battery",
    name: "One battery",
    description: "Decide what the battery powers.",
    status: "active",
    objectives: [
      {
        id: "read-gauge",
        text: "Read the gauge",
        done: false,
        deadline: {
          when: { dimension: "floodline", path: "stage", in: ["knee"] },
          label: "Before the water reaches the knee",
          missed: "The gauge is under water now.",
        },
      },
      { id: "choose", text: "Choose priorities", done: false },
    ],
  },
];

function turnContext({ elapsed, stage, turnId = "turn-4", sourceTurnId }) {
  return {
    sessionId: "sess-deadline",
    turnId,
    pluginId: "core-quest",
    runtimeId: "core-quest/deadline",
    logicalTurn: 4,
    locale: "en-US",
    messages,
    random: makeRandom(),
    recursionDepth: 0,
    ...(sourceTurnId ? { execution: { sourceTurnId } } : {}),
    world: {
      dimensions: { floodline: { value: { stage }, version: 3 } },
    },
    inputs: {
      worldTime: {
        value: { elapsedSinceStart: elapsed, units: ["minute", "hour", "day"] },
      },
    },
  };
}

async function seed(store) {
  const now = new Date().toISOString();
  for (const quest of seeded)
    await store.setPluginData({
      id: quest.id,
      sessionId: "sess-deadline",
      pluginId: "core-quest",
      namespace: "quests",
      key: quest.id,
      value: quest,
      createdAt: now,
      updatedAt: now,
    });
}

async function run(store, ctx) {
  return bindToolStore(
    { execute: (_params, context) => deadline(context) },
    store,
  ).execute({}, ctx);
}

async function quests(store) {
  const rows = await store.listPluginData(
    "sess-deadline",
    "core-quest",
    "quests",
  );
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

describe("core-quest deadlines", () => {
  it("tells the story the open deadlines and shows them on the quests from the first turn", async () => {
    const ctx = turnContext({ elapsed: 30, stage: "trackbed" });
    const store = await createPluginTestStore(ctx);
    await seed(store);
    const result = await run(store, ctx);
    expect(getToolContent(result).value).toEqual({
      failed: 0,
      due: 2,
      storyContext: {
        title: "Quest deadlines",
        content: [
          "These quests have deadlines. Let the player feel the time running out in the story:",
          '- "Read the gauge" of One battery: Before the water reaches the knee',
          "- The three who walked: Before their lamps are out of sight (about 15 minutes left)",
        ].join("\n"),
      },
    });
    // The seeded quests get their chips; no quest changed, so no changes block.
    const [proposal] = getPendingProposals(result);
    expect(proposal.payload.items.map((item) => item.namespace)).toEqual([
      "quests",
      "quests",
    ]);
    await commitToolResults([result], ctx, store);
    const stored = await quests(store);
    expect(stored["reach-theo"].chips).toEqual([
      "☐ Follow the lamps",
      "⌛ Before their lamps are out of sight",
    ]);
    expect(stored["one-battery"].chips).toContain(
      "☐ Read the gauge ⌛ Before the water reaches the knee",
    );
    // Written once: the next turn has nothing to refresh.
    expect(
      getPendingProposals(
        await run(store, turnContext({ elapsed: 35, stage: "trackbed" })),
      ),
    ).toEqual([]);
  });

  it("fails a quest and misses an objective once their deadline passes, and keeps them that way", async () => {
    const ctx = turnContext({ elapsed: 50, stage: "knee" });
    const store = await createPluginTestStore(ctx);
    await seed(store);
    const result = await run(store, ctx);
    expect(getToolContent(result).value.storyContext.content).toBe(
      [
        "These deadlines have just passed. This turn's story makes the result happen; do not offer the missed task to the player again:",
        '- "Read the gauge" of One battery: The gauge is under water now.',
        "- The three who walked: The lamps ahead are gone; you walk on alone.",
      ].join("\n"),
    );
    await commitToolResults([result], ctx, store);
    const stored = await quests(store);
    expect(stored["reach-theo"]).toMatchObject({
      status: "failed",
      missed: {
        label: "Before their lamps are out of sight",
        text: "The lamps ahead are gone; you walk on alone.",
        turn: 4,
      },
    });
    expect(stored["one-battery"].status).toBe("active");
    expect(stored["one-battery"].objectives[0].missed).toMatchObject({
      text: "The gauge is under water now.",
    });
    expect(stored["one-battery"].chips[0]).toBe("✗ Read the gauge");
    const block = await store.getPluginData(
      "sess-deadline",
      "core-quest",
      "message",
      "turn-4",
    );
    expect(block.value.changes).toEqual([
      expect.objectContaining({
        name: "One battery",
        badge: expect.objectContaining({ en: "Missed" }),
        color: "amber",
      }),
      expect.objectContaining({
        name: "The three who walked",
        badge: expect.objectContaining({ en: "Failed" }),
        color: "red",
        detail: "The lamps ahead are gone; you walk on alone.",
      }),
    ]);

    // Later reports cannot bring them back: it is too late.
    const later = { ...ctx, turnId: "turn-5", runtimeId: "core-quest/log" };
    const upsert = await bindToolStore(
      { execute: upsertQuests },
      store,
    ).execute(
      {
        quests: [
          { name: "The three who walked", status: "completed" },
          {
            name: "One battery",
            objectives: [
              { id: "read-gauge", text: "Read the gauge", done: true },
            ],
          },
        ],
      },
      later,
    );
    await commitToolResults([upsert], later, store);
    const after = await quests(store);
    expect(after["reach-theo"].status).toBe("failed");
    expect(after["one-battery"].objectives[0].done).toBe(false);
    // The vocabulary no longer offers what was missed.
    const published = await bindToolStore(
      { execute: (_p, context) => vocabulary(context) },
      store,
    ).execute({}, later);
    expect(published.value.entries).toEqual([
      { type: "quest", name: "One battery", details: ["Choose priorities"] },
    ]);
  });

  it("repeats this turn's failures to a retried story without writing them again", async () => {
    const ctx = turnContext({ elapsed: 50, stage: "trackbed" });
    const store = await createPluginTestStore(ctx);
    await seed(store);
    await commitToolResults([await run(store, ctx)], ctx, store);
    const retry = await run(
      store,
      turnContext({
        elapsed: 50,
        stage: "trackbed",
        turnId: "turn-4b",
        sourceTurnId: "turn-4",
      }),
    );
    expect(getPendingProposals(retry)).toEqual([]);
    expect(getToolContent(retry).value.storyContext.content).toContain(
      "- The three who walked: The lamps ahead are gone; you walk on alone.",
    );
  });

  it.each([
    [
      "a dimension the session does not have",
      { dimension: "tide", equals: "high" },
    ],
    ["two operators", { time: "elapsedSinceStart", gte: 1, lt: 99 }],
    ["no operator", { dimension: "floodline", path: "stage" }],
  ])(
    "never fails a quest on a deadline it cannot judge: %s",
    async (_name, when) => {
      const ctx = {
        ...turnContext({ elapsed: 500, stage: "knee" }),
        inputs: {},
      };
      const result = await deadline({
        ...ctx,
        store: {
          getPluginData: async () => null,
          listPluginData: async () => [
            {
              key: "q",
              value: {
                id: "q",
                name: "Q",
                description: "",
                status: "active",
                deadline: { when, label: "Soon" },
              },
            },
          ],
        },
      });
      expect(getToolContent(result).value).toMatchObject({ failed: 0, due: 1 });
      // Without world time, the time left is not guessed.
      expect(getToolContent(result).value.storyContext.content).toContain(
        "- Q: Soon",
      );
    },
  );

  it("reads how an NPC feels from affinity.tier@1, and leaves the deadline open without it", async () => {
    const quest = {
      key: "keep-graham",
      value: {
        id: "keep-graham",
        name: "Keep Graham with the car",
        description: "",
        status: "active",
        deadline: {
          when: {
            affinity: "Graham Pike",
            path: "tier",
            in: ["cold", "hostile"],
          },
          label: "While Graham still listens to you",
          missed: "Graham goes back to the pump room alone.",
        },
      },
    };
    const store = {
      getPluginData: async () => null,
      listPluginData: async () => [quest],
    };
    const services = (tier) => ({
      discover: async (contract) =>
        contract === "affinity.tier@1"
          ? [{ pluginId: "affinity", name: "tiers", contract }]
          : [],
      call: async () => ({
        tiers: ["hostile", "cold", "neutral", "friendly", "close", "devoted"],
        characters: [{ name: "Graham Pike", score: -30, tier, label: tier }],
      }),
    });
    const ctx = turnContext({ elapsed: 0, stage: "trackbed" });
    const cold = await deadline({ ...ctx, store, services: services("cold") });
    expect(getToolContent(cold).value.failed).toBe(1);
    expect(getPendingProposals(cold)[0].payload.items[0].value).toMatchObject({
      status: "failed",
      missed: { text: "Graham goes back to the pump room alone." },
    });
    const neutral = await deadline({
      ...ctx,
      store,
      services: services("neutral"),
    });
    expect(getToolContent(neutral).value).toMatchObject({ failed: 0, due: 1 });
    // No affinity plugin: the deadline cannot be judged and stays open.
    const alone = await deadline({ ...ctx, store });
    expect(getToolContent(alone).value).toMatchObject({ failed: 0, due: 1 });
  });

  it("writes nothing and says nothing for quests without deadlines", async () => {
    const result = await deadline({
      ...turnContext({ elapsed: 0, stage: "trackbed" }),
      store: {
        getPluginData: async () => null,
        listPluginData: async () => [
          {
            key: "q",
            value: { id: "q", name: "Q", description: "", status: "active" },
          },
        ],
      },
    });
    expect(result).toEqual({
      outcome: "success",
      value: { failed: 0, due: 0, storyContext: null },
    });
  });
});
