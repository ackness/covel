import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginMessages, makeRandom } from "@covel/plugin-test-utils";
import roller from "../runtimes/roller/handler.js";
import recorder from "../runtimes/recorder/handler.js";
import verifyCheckReceipt, {
  acceptRecordedReceipt,
} from "../hooks/verify-check-receipt.js";
import reviewCostProse from "../hooks/review-cost-prose.js";
import { forgetPool } from "../lib/turn-pool.js";

const messages = await loadPluginMessages(new URL("..", import.meta.url), "en");

const ability = (id, name) => ({
  id,
  name,
  type: "number",
  min: 0,
  max: 5,
  category: "abilities",
});
const world = {
  seats: [
    { id: "main", controller: "human", role: "player", characters: "auto" },
  ],
  characterSchema: {
    attributes: [
      ability("wayfinding", "Wayfinding"),
      ability("rapport", "Rapport"),
      ability("stamina", "Stamina"),
    ],
  },
  characters: [
    {
      id: "p1",
      type: "player",
      name: "Sam",
      // +6, +4 and +2 by the range conversion.
      fields: { wayfinding: 3, rapport: 2, stamina: 1 },
    },
  ],
};

/** This plugin's data: one cost, and a full clock that raises stamina. */
function storeOf() {
  const data = {
    consequences: [
      {
        id: "car-hears-it",
        text: "The car hears it go wrong.",
        cues: ["mark"],
        cost: { kind: "clock", clock: "panic" },
      },
    ],
    clocks: [
      { id: "panic", name: "Panic", segments: 4, full: "The car panics." },
      {
        id: "exposure",
        name: "Cold and wet",
        segments: 2,
        full: "Your hands are numb.",
        raises: ["stamina"],
      },
    ],
    "clock-progress": [
      {
        id: "exposure",
        name: "Cold and wet",
        segments: 2,
        filled: 2,
        progressText: "2/2",
        isFull: true,
        whenFull: "Your hands are numb.",
        fullTurn: 1,
      },
    ],
  };
  return {
    get: vi.fn(
      async (namespace, key) =>
        data[namespace]?.find((value) => value.id === key) ?? null,
    ),
    list: vi.fn(async (namespace) =>
      (data[namespace] ?? []).map((value) => ({ key: value.id, value })),
    ),
  };
}

/** One inventory with a torch and a charm, and an affinity plugin. */
function services() {
  return {
    discover: vi.fn(async (contract) => [
      { pluginId: contract.split(".")[0], name: "service", contract },
    ]),
    call: vi.fn(async ({ contract }) => {
      if (contract === "inventory.bag@2")
        return {
          total: 3,
          items: [
            {
              name: "Pocket torch",
              quantity: 1,
              equipped: true,
              effects: { check: { attribute: "wayfinding", modifier: 2 } },
            },
            {
              name: "Lucky charm",
              quantity: 1,
              effects: { check: { attribute: "Wayfinding", modifier: 1 } },
            },
            {
              name: "Staff key",
              quantity: 1,
              effects: { check: { attribute: "mechanics", modifier: 2 } },
            },
          ],
        };
      if (contract === "affinity.tier@1")
        return {
          tiers: ["hostile", "cold", "neutral", "friendly", "close", "devoted"],
          characters: [
            { name: "Graham Pike", score: -35, tier: "cold", label: "Cold" },
            {
              name: "Kit Alvarez",
              score: 30,
              tier: "friendly",
              label: "Friendly",
            },
          ],
        };
      throw new Error(`unexpected ${contract}`);
    }),
  };
}

const base = {
  pluginId: "dice-check",
  sessionId: "sess-plan",
  turnId: "turn-4",
  logicalTurn: 4,
  locale: "en-US",
  messages,
  world,
};

// The seeded dice of these turns: 5, 8 and 11.
async function rollTurn(overrides = {}) {
  return roller({
    ...base,
    runtimeId: "dice-check/roller",
    random: makeRandom(),
    pluginData: storeOf(),
    services: services(),
    ...overrides,
  });
}

const emit = (checks) => ({
  toolCall: {
    id: "emit",
    name: "emit-event",
    arguments: JSON.stringify({ topic: "check.resolved", data: { checks } }),
  },
});
const guard = (checks) => verifyCheckReceipt(base, emit(checks));

// What the narrative was told, read correctly.
const torchCheck = {
  action: "Find the crossover in the dark",
  attribute: "wayfinding",
  modifier: 8,
  difficulty: "normal",
  outcome: "success", // 5 + 8 = 13 vs DC 12
};
const grahamCheck = {
  action: "Ask Graham to hold the door",
  attribute: "rapport",
  modifier: 4,
  difficulty: "normal",
  with: "graham pike",
  outcome: "failure", // 8 + 4 = 12 vs DC 16, not 12
};
const numbCheck = {
  action: "Climb onto the walkway",
  attribute: "stamina",
  modifier: 2,
  difficulty: "normal",
  outcome: "failure", // 11 + 2 = 13 vs DC 16, not 12
};

afterEach(() => forgetPool(base.sessionId, base.turnId));

describe("dice-check items and harder checks", () => {
  it("tells the narrative the best item in a modifier and why checks are harder", async () => {
    const result = await rollTurn();
    expect(result.value.dice).toEqual([5, 8, 11]);
    const context = result.value.checkContext;
    expect(context).toContain("- Wayfinding 3/5 → +8 (+6, Pocket torch +2)");
    expect(context).toContain("- Rapport 2/5 → +4\n");
    expect(context).not.toContain("Lucky charm");
    expect(context).not.toContain("Staff key");
    expect(context).toContain("## Harder checks");
    expect(context).toContain(
      "- Graham Pike (Cold) does not want to help you. When an action needs this person's help or agreement, put the name in `with` in the receipt: one step harder.",
    );
    expect(context).toContain(
      "- Cold and wet is full: Stamina checks are one step harder.",
    );
    expect(context).not.toContain("Kit Alvarez");
    expect(result.value.checkPlan).toMatchObject({
      modifiers: {
        wayfinding: {
          base: 6,
          total: 8,
          item: { name: "Pocket torch", modifier: 2 },
        },
      },
      unhelpful: [{ name: "Graham Pike", label: "Cold", steps: 1 }],
      raised: { stamina: ["Cold and wet"] },
    });
  });

  it("leaves items and tiers out without the services that provide them", async () => {
    const result = await roller({
      ...base,
      runtimeId: "dice-check/roller",
      random: makeRandom(),
    });
    expect(result.value.checkContext).toContain("- Wayfinding 3/5 → +6\n");
    expect(result.value.checkContext).not.toContain("## Harder checks");
    expect(result.value.checkPlan).toMatchObject({
      unhelpful: [],
      raised: {},
    });
  });

  it("lets a receipt through that follows the plan, and sends back a wrong modifier or a difficulty that was not raised", async () => {
    await rollTurn();
    expect(guard([torchCheck, grahamCheck, numbCheck])).toEqual({
      action: "continue",
    });

    const withoutTorch = guard([
      { ...torchCheck, modifier: 6, outcome: "failure" },
    ]);
    expect(withoutTorch.action).toBe("abort");
    expect(withoutTorch.reason).toContain(
      "check 1 reports modifier 6 and the modifier list gives 8 for wayfinding",
    );
    expect(withoutTorch.reason).toContain("d20 5 + 8 = 13 vs DC 12 -> success");

    const notRaised = guard([
      torchCheck,
      { ...grahamCheck, outcome: "success" },
    ]);
    expect(notRaised.action).toBe("abort");
    expect(notRaised.reason).toContain(
      "check 2 (hard (normal made hard by Graham Pike (Cold))): d20 8 + 4 = 12 vs DC 16 -> failure",
    );
    // A person who is not on the list changes nothing.
    expect(
      guard([
        torchCheck,
        { ...grahamCheck, with: "Kit Alvarez", outcome: "success" },
      ]),
    ).toEqual({ action: "continue" });
  });

  it("records the item and the harder difficulty the player sees", async () => {
    const { value } = await rollTurn();
    const result = await recorder({
      ...base,
      runtimeId: "dice-check/recorder",
      triggerEvent: {
        topic: "check.resolved",
        data: { checks: [torchCheck, grahamCheck, numbCheck] },
      },
      inputs: {
        dicePool: { value: value.dice },
        checkPlan: { value: value.checkPlan },
        costPlan: { value: value.costPlan },
      },
      pluginData: storeOf(),
    });
    expect(result.outcome).toBe("success");
    const checks = result.effects.pluginData
      .filter((write) => write.namespace === "checks")
      .map((write) => write.value);
    expect(checks[0]).toMatchObject({
      bonusText: "Pocket torch +2",
      rollText: "5 + 8 = 13 vs DC 12",
    });
    expect(checks[0].harderText).toBeUndefined();
    expect(checks[1]).toMatchObject({
      difficulty: "hard",
      harderText: "Graham Pike (Cold)",
      harderDetail: "DC 12 → 16",
      outcome: "failure",
      costDetail: "Panic +1 (1/4)",
    });
    expect(checks[1].bonusText).toBeUndefined();
    expect(checks[2]).toMatchObject({
      harderText: "Cold and wet",
      harderDetail: "DC 12 → 16",
      costDetail: "Panic +1 (2/4)",
    });
  });

  it.each([undefined, "unlisted"])(
    "rejects bypassing a full clock with attribute %s",
    async (attribute) => {
      await rollTurn();
      const result = guard([
        { ...numbCheck, attribute, modifier: 10, outcome: "success" },
      ]);
      expect(result).toMatchObject({
        action: "abort",
        reason: expect.stringContaining(
          "choose an attribute from the modifier list",
        ),
      });
    },
  );

  it("records nothing and pays nothing for a receipt that leaves out the item", async () => {
    const { value } = await rollTurn();
    const result = await recorder({
      ...base,
      runtimeId: "dice-check/recorder",
      triggerEvent: {
        topic: "check.resolved",
        data: { checks: [{ ...torchCheck, modifier: 6, outcome: "failure" }] },
      },
      inputs: {
        dicePool: { value: value.dice },
        checkPlan: { value: value.checkPlan },
        costPlan: { value: value.costPlan },
      },
      pluginData: storeOf(),
    });
    expect(result.outcome).toBe("failed");
    expect(result.effects).toBeUndefined();
  });
});

describe("dice-check review with the check plan", () => {
  const ctx = { ...base, runtimeId: "narrator" };
  const story = (text) => ({
    output: { segments: [{ kind: "narration", text }] },
    toolCall: { id: "submit", name: "submit-output" },
    toolResults: [],
  });
  async function recordedTurn(checks) {
    await rollTurn();
    acceptRecordedReceipt(ctx, {
      ...emit(checks),
      result: {
        success: true,
        emittedEvents: [{ topic: "check.resolved", data: { checks } }],
      },
    });
  }

  it("reviews only the failed checks the recorder records", async () => {
    // The recorder skips a check that ignores the harder difficulty.
    await recordedTurn([torchCheck, { ...grahamCheck, difficulty: "easy" }]);
    expect(reviewCostProse(ctx, story("Graham shrugs."))).toEqual({
      action: "continue",
    });
  });

  it("finds a cue at the start of a word, not inside one", async () => {
    await recordedTurn([numbCheck]);
    expect(reviewCostProse(ctx, story("Kit makes a remark."))).toHaveProperty(
      "replace.correction",
    );
    forgetPool(base.sessionId, base.turnId);
    await recordedTurn([numbCheck]);
    expect(
      reviewCostProse(ctx, story("Everyone in the car marked the slip.")),
    ).toEqual({ action: "continue" });
  });
});
