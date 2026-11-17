import {
  completedBusinessOutput,
  submittedOutput,
  submittedStory,
} from "../helpers/output-submission.js";
/**
 * The two gameplay chains of the bundled plugins in a real turn:
 *
 * - A failed dice check pays its world-authored cost: the cost is told to the
 *   story before it is written, the recorder pays it through the commit (a
 *   clock in dice-check's own dataset, an item through the inventory's write
 *   service), and a story that skips the cost is sent back once by
 *   dice-check's review hook.
 * - A quest whose deadline has passed fails before the story, and the story
 *   is told so through `story-context@1`.
 * - A carried item adds its modifier to a check and an NPC who has gone cold
 *   makes a check that needs them harder, read through `inventory.bag@2` and
 *   `affinity.tier@1`; the receipt is held to both.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import path from "node:path";
import type { LLMAdapter, LLMResponse } from "@covel/runtime";
import { createMemoryStore } from "@covel/store/memory";
import { bootstrapApi } from "../../src/routes/api/bootstrap.js";
import { closeTestApi } from "../helpers/close-api.js";

const PLUGINS_DIR = path.resolve(import.meta.dirname, "../../../../plugins");
const CORRECTION = "does not show the cost of a failed check";
const DCS = { easy: 8, normal: 12, hard: 16, extreme: 20 } as const;

/** The outcome the dice-check rules give. */
function outcomeOf(roll: number, modifier: number, dc: number) {
  if (roll === 20) return "critical-success";
  if (roll === 1) return "critical-failure";
  return roll + modifier >= dc ? "success" : "failure";
}

type Receipt = (dice: number[]) => Record<string, unknown>[];

// Extreme (DC 20) with modifier 0: every die but a 20 fails.
const wadeOn: Receipt = (dice) =>
  dice.map((roll, index) => ({
    action: `Wade the flooded stretch, attempt ${index + 1}`,
    attribute: "stamina",
    modifier: 0,
    difficulty: "extreme",
    outcome: outcomeOf(roll, 0, DCS.extreme),
  }));

/** Answers the story; reports this turn's checks first when there are dice. */
class ScriptedNarrator implements LLMAdapter {
  dice: number[] = [];
  submissions = 0;
  corrected = false;
  storyPrompts: string[] = [];
  receipt: Receipt = wadeOn;
  facts: Record<string, unknown> = {};

  async generate(
    params: Parameters<LLMAdapter["generate"]>[0],
  ): Promise<LLMResponse> {
    if (params.tools?.some(({ name }) => name === "submit-world-facts")) {
      if (completedBusinessOutput(params.messages, "submit-world-facts"))
        return submittedOutput({});
      return {
        content: null,
        toolCalls: [
          {
            id: "facts",
            name: "submit-world-facts",
            arguments: JSON.stringify(this.facts),
          },
        ],
        finishReason: "tool_calls",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }
    // Other runtimes of the session (character creation, world time) get a
    // plain answer; only the story is scripted.
    if (!params.tools?.some((tool) => tool.name === "emit-event"))
      return submittedStory("You push on.");
    const text = JSON.stringify(params.messages);
    const emitted = params.messages.some((message) =>
      message.toolCalls?.some((call) => call.name === "emit-event"),
    );
    // The turn's check table: `| 1 | <d20> | ...` for each check.
    const dice = [...text.matchAll(/\| (\d) \| (\d+) \|/g)].map((match) =>
      Number(match[2]),
    );
    if (!emitted && dice.length > 0) {
      this.dice = dice;
      this.storyPrompts.push(text);
      return {
        content: null,
        toolCalls: [
          {
            id: "receipt",
            name: "emit-event",
            arguments: JSON.stringify({
              topic: "check.resolved",
              data: { checks: this.receipt(dice) },
            }),
          },
        ],
        finishReason: "tool_calls",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }
    this.submissions += 1;
    this.storyPrompts.push(text);
    this.corrected ||= text.includes(CORRECTION);
    return submittedStory(
      this.corrected
        ? "You push on. The cold climbs your legs, and a stick of chalk crumbles to nothing in your fist."
        : "You push on through the dark water.",
    );
  }
}

describe("gameplay chains in a turn", () => {
  let boot: Awaited<ReturnType<typeof bootstrapApi>>;
  const narrator = new ScriptedNarrator();
  const store = createMemoryStore();

  beforeAll(async () => {
    vi.stubEnv("COVEL_RANDOM_SEED", "11");
    boot = await bootstrapApi({
      pluginsDir: PLUGINS_DIR,
      llmAdapter: narrator,
      store,
      storeBackend: "memory",
    });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await closeTestApi(boot);
    await store.close();
  });

  /** A session in play with these plugins and stamina and wayfinding abilities. */
  async function playingSession(
    plugins: readonly string[],
    fields = { stamina: 0, wayfinding: 0 },
  ) {
    const created = await boot.app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locale: "en-US", plugins }),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const { id: sessionId } = (await created.json()) as { id: string };
    const now = new Date().toISOString();
    await store.upsertCharacterSchema({
      sessionId,
      version: 1,
      types: ["npc", "companion"],
      attributes: [
        ["stamina", "Stamina"],
        ["wayfinding", "Wayfinding"],
      ].map(([id, name]) => ({
        id: id!,
        name: name!,
        type: "number" as const,
        min: 0,
        max: 5,
        category: "abilities",
      })),
      createdAt: now,
      updatedAt: now,
    });
    await store.upsertCharacter({
      id: `player-${sessionId}`,
      sessionId,
      name: "Sam",
      type: "player",
      fields,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const session = await store.getSession(sessionId);
    await store.updateSession(sessionId, {
      phase: "playing",
      setupRuntimes: Object.fromEntries(
        Object.entries(session!.setupRuntimes).map(([runtimeId, state]) => [
          runtimeId,
          {
            ...state,
            state: "done" as const,
            resolution: "completed" as const,
            attempts: Math.max(1, state.attempts),
            completedAt: now,
          },
        ]),
      ),
      updatedAt: now,
    });
    return sessionId;
  }

  /** What a world would import into a plugin's namespace. */
  async function seed(
    sessionId: string,
    pluginId: string,
    namespace: string,
    rows: readonly Record<string, unknown>[],
  ) {
    const now = new Date().toISOString();
    for (const value of rows)
      await store.setPluginData({
        id: `${namespace}-${String(value.id)}`,
        sessionId,
        pluginId,
        namespace,
        key: String(value.id),
        value: value as never,
        createdAt: now,
        updatedAt: now,
      });
  }

  async function playTurn(sessionId: string, requestId: string) {
    const response = await boot.app.request("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId,
        type: "submit_actions",
        sessionId,
        payload: { actions: [{ kind: "say", text: "Wade on" }] },
      }),
    });
    const stream = await response.text();
    expect(response.status, stream).toBe(200);
    expect(stream).not.toContain('"error.occurred"');
  }

  it("pays the cost of failed checks through the commit and sends back a story that skips it", async () => {
    const sessionId = await playingSession([
      "narrator",
      "dice-check",
      "inventory",
    ]);
    // A failure loses chalk while there is any; anything else that fails
    // fills the cold clock.
    await seed(sessionId, "dice-check", "consequences", [
      {
        id: "chalk",
        outcome: "failure",
        text: "A stick of chalk crumbles in your fist.",
        cues: ["chalk"],
        cost: { kind: "item", item: "Chalk" },
      },
      {
        id: "cold",
        text: "The cold climbs your legs.",
        cues: ["cold"],
        cost: { kind: "clock", clock: "exposure" },
      },
    ]);
    await seed(sessionId, "dice-check", "clocks", [
      { id: "exposure", name: "Cold", segments: 12, full: "You shiver." },
    ]);
    await seed(sessionId, "inventory", "items", [
      { id: "chalk", name: "Chalk", quantity: 1 },
    ]);

    narrator.receipt = wadeOn;
    narrator.storyPrompts = [];
    await playTurn(sessionId, "req-cost-1");
    expect(narrator.storyPrompts[0]).toContain("Cost of failure");

    const failures = narrator.dice.filter((roll) => roll > 1 && roll < 20);
    const criticals = narrator.dice.filter((roll) => roll === 1);
    // This seed rolls two failed checks, so both kinds of cost are paid.
    expect(failures.length + criticals.length).toBeGreaterThanOrEqual(2);

    // Every failed check paid: the first failure took the only chalk, the
    // other failed checks filled the clock.
    const checks = (
      await store.listPluginData(sessionId, "dice-check", "checks")
    ).map((row) => row.value as Record<string, unknown>);
    expect(checks).toHaveLength(3);
    expect(checks.filter((check) => check.costText)).toHaveLength(
      failures.length + criticals.length,
    );
    const chalk = await store.getPluginData(
      sessionId,
      "inventory",
      "items",
      "chalk",
    );
    expect(chalk?.value).toMatchObject({
      quantity: failures.length > 0 ? 0 : 1,
    });
    const clock = await store.getPluginData(
      sessionId,
      "dice-check",
      "clock-progress",
      "exposure",
    );
    expect(clock?.value).toMatchObject({
      filled: criticals.length + Math.max(failures.length - 1, 0),
      segments: 12,
    });

    // The first story skipped the cost and was sent back once.
    expect(narrator.corrected).toBe(true);
    expect(narrator.submissions).toBe(2);
    expect(JSON.stringify(await store.listTurnMessages(sessionId))).toContain(
      "chalk crumbles",
    );
  });

  it("adds a carried item to a check and makes a check that needs a cold NPC harder", async () => {
    const sessionId = await playingSession(
      ["narrator", "dice-check", "inventory", "affinity"],
      { stamina: 2, wayfinding: 3 },
    );
    await seed(sessionId, "inventory", "items", [
      ...Array.from({ length: 100 }, (_, index) => ({
        id: `filler-${index}`,
        name: `Book ${index % 50}`,
        quantity: 1,
        equipped: true,
      })),
      {
        id: "pocket-torch",
        name: "Pocket torch",
        quantity: 1,
        effects: { check: { attribute: "wayfinding", modifier: 2 } },
      },
    ]);
    await seed(sessionId, "affinity", "affinity", [
      ...Array.from({ length: 8 }, (_, index) => ({
        id: `hostile-${index}`,
        name: `Hostile character ${index}`,
        score: -100,
      })),
      { id: "graham-pike", name: "Graham Pike", score: -35 },
    ]);
    narrator.storyPrompts = [];
    narrator.receipt = ([first, second]) => [
      {
        action: "Read the signs to the crossover",
        attribute: "wayfinding",
        modifier: 8,
        difficulty: "normal",
        outcome: outcomeOf(first!, 8, DCS.normal),
      },
      {
        action: "Get Graham to hold the hatch",
        attribute: "stamina",
        modifier: 4,
        difficulty: "normal",
        with: "Graham Pike",
        outcome: outcomeOf(second!, 4, DCS.hard),
      },
    ];

    await playTurn(sessionId, "req-plan-1");

    const prompt = narrator.storyPrompts[0] ?? "";
    expect(prompt).toContain("- Wayfinding 3/5 → +8 (+6, Pocket torch +2)");
    expect(prompt).toContain("Graham Pike (Cold) does not want to help you.");
    const checks = (
      await store.listPluginData(sessionId, "dice-check", "checks")
    ).map((row) => row.value as Record<string, unknown>);
    expect(checks).toEqual([
      expect.objectContaining({ modifier: 8, bonusText: "Pocket torch +2" }),
      expect.objectContaining({
        difficulty: "hard",
        dc: 16,
        harderText: "Graham Pike (Cold)",
        harderDetail: "DC 12 → 16",
      }),
    ]);
  });

  it.each([
    { quantity: 1, loss: 1 },
    { quantity: 2, loss: 1 },
    { quantity: 3, loss: 2 },
  ])(
    "settles a check cost included in a loss of $loss from $quantity chalk",
    async ({ quantity, loss }) => {
      const sessionId = await playingSession([
        "narrator",
        "dice-check",
        "inventory",
        "world-ir",
      ]);
      await seed(sessionId, "dice-check", "consequences", [
        {
          id: "chalk",
          text: "A stick of chalk crumbles in your fist.",
          cues: ["chalk"],
          cost: { kind: "item", item: "Chalk" },
        },
      ]);
      await seed(sessionId, "inventory", "items", [
        { id: "chalk", name: "Chalk", quantity },
      ]);
      narrator.receipt = (dice) => wadeOn(dice.slice(0, 1));
      narrator.corrected = false;
      narrator.facts = {
        schemaVersion: 1,
        entities: [
          { id: "sam", type: "character", name: "Sam" },
          { id: "chalk", type: "item", name: "Chalk" },
          { id: "rope", type: "item", name: "Rope" },
        ],
        relations: [],
        statements: [],
        events: [
          {
            id: "lost-chalk",
            type: "inventory_change",
            attributes: {
              holder: "sam",
              item: "chalk",
              operation: "lose",
              quantity: loss,
            },
          },
          {
            id: "found-rope",
            type: "inventory_change",
            attributes: { holder: "sam", item: "rope", operation: "gain" },
          },
        ],
      };

      await playTurn(sessionId, `req-extracted-cost-${quantity}`);

      expect(
        await store.listPluginData(sessionId, "dice-check", "checks"),
      ).toEqual([
        expect.objectContaining({
          value: expect.objectContaining({
            costText: "A stick of chalk crumbles in your fist.",
          }),
        }),
      ]);
      expect(
        (await store.listPluginData(sessionId, "inventory", "items")).map(
          ({ value }) => value,
        ),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "Chalk", quantity: quantity - loss }),
          expect.objectContaining({ name: "Rope", quantity: 1 }),
        ]),
      );
    },
  );

  it("fails an overdue quest before the story and tells the story", async () => {
    const sessionId = await playingSession([
      "narrator",
      "core-quest",
      "world-time",
    ]);
    await seed(sessionId, "core-quest", "quests", [
      {
        id: "reach-theo",
        name: "The three who walked",
        description: "Catch up with the three who walked ahead.",
        status: "active",
        deadline: {
          when: { time: "elapsedSinceStart", gte: 0 },
          label: "Before their lamps are out of sight",
          missed: "The lamps ahead are gone; you walk on alone.",
        },
      },
      {
        id: "one-battery",
        name: "One battery",
        description: "Decide what the battery powers.",
        status: "active",
        deadline: {
          when: { time: "elapsedSinceStart", gte: 60 },
          label: "Before the water is knee-deep",
        },
      },
    ]);
    narrator.storyPrompts = [];

    await playTurn(sessionId, "req-deadline-1");

    const prompt = narrator.storyPrompts.at(-1) ?? "";
    expect(prompt).toContain("<story-context>");
    expect(prompt).toContain(
      "- The three who walked: The lamps ahead are gone; you walk on alone.",
    );
    expect(prompt).toContain(
      "- One battery: Before the water is knee-deep (about 60 minutes left)",
    );
    const failed = await store.getPluginData(
      sessionId,
      "core-quest",
      "quests",
      "reach-theo",
    );
    expect(failed?.value).toMatchObject({
      status: "failed",
      missed: { text: "The lamps ahead are gone; you walk on alone." },
    });
    const changes = (
      await store.listPluginData(sessionId, "core-quest", "message")
    ).flatMap((row) => (row.value as { changes: { name: string }[] }).changes);
    expect(changes).toEqual([
      expect.objectContaining({ name: "The three who walked", color: "red" }),
    ]);
  });
});
