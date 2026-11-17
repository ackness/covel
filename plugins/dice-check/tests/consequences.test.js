import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginMessages, makeRandom } from "@covel/plugin-test-utils";
import roller from "../runtimes/roller/handler.js";
import recorder from "../runtimes/recorder/handler.js";
import reviewCostProse from "../hooks/review-cost-prose.js";
import { acceptRecordedReceipt } from "../hooks/verify-check-receipt.js";
import { forgetPool } from "../lib/turn-pool.js";

const messages = await loadPluginMessages(new URL("..", import.meta.url), "en");

const world = {
  seats: [
    { id: "main", controller: "human", role: "player", characters: "auto" },
  ],
  characters: [
    {
      id: "player",
      name: "Sam",
      type: "player",
      fields: { stamina: 0, wayfinding: 0 },
    },
  ],
  characterSchema: {
    attributes: [
      {
        id: "stamina",
        name: { "en-US": "Stamina", "zh-CN": "体力" },
        type: "number",
        min: 0,
        max: 5,
        category: "abilities",
      },
      {
        id: "wayfinding",
        name: "Wayfinding",
        type: "number",
        min: 0,
        max: 5,
        category: "abilities",
      },
    ],
  },
};

// What a world imports: costs by attribute and outcome, and one clock.
const consequences = [
  {
    id: "soaked",
    attribute: "stamina",
    text: "Cold water soaks you to the waist.",
    cues: ["soak", "cold"],
    cost: { kind: "clock", clock: "cold", ticks: 2 },
  },
  {
    id: "chalk",
    attribute: "wayfinding",
    text: "You use up a stick of chalk on false marks.",
    cues: ["chalk"],
    cost: { kind: "item", item: "Track chalk" },
  },
  {
    id: "phone",
    outcome: "critical-failure",
    text: "Your phone slips into the water.",
    cues: ["phone"],
    cost: { kind: "item", item: "Phone" },
  },
  {
    id: "panic",
    text: "The car hears it go wrong.",
    cues: ["panic", "shout"],
    cost: { kind: "clock", clock: "panic" },
  },
];
const clocks = [
  { id: "cold", name: "Cold and wet", segments: 4, full: "You shiver." },
  { id: "panic", name: "Panic", segments: 4, full: "The car panics." },
];

/** Plugin data of this plugin, as committed before the turn. */
function storeOf(rows = {}) {
  const data = new Map(
    Object.entries({
      consequences: consequences.map((value) => ({ key: value.id, value })),
      clocks: clocks.map((value) => ({ key: value.id, value })),
      ...rows,
    }),
  );
  return {
    get: vi.fn(
      async (namespace, key) =>
        data.get(namespace)?.find((row) => row.key === key)?.value ?? null,
    ),
    list: vi.fn(async (namespace) => data.get(namespace) ?? []),
    set: vi.fn(),
    delete: vi.fn(),
  };
}

/** A bag with these items, and an inventory that refuses what it lacks. */
function inventory(held) {
  const bag = new Map(Object.entries(held));
  return {
    discover: vi.fn(async (contract) =>
      contract.startsWith("inventory.")
        ? [{ pluginId: "bag-plugin", name: "bag", contract }]
        : [],
    ),
    call: vi.fn(async ({ contract, input }) => {
      if (contract === "inventory.bag@2") {
        const query = input.query ?? "";
        return {
          items: [...bag]
            .filter(([name]) => name.toLowerCase().includes(query))
            .map(([name, quantity]) => ({ name, quantity })),
        };
      }
      for (const change of input.changes) {
        if ((bag.get(change.item) ?? 0) < (change.quantity ?? 1))
          throw Object.assign(new Error("refused"), { code: "refused" });
      }
      return { results: [] };
    }),
  };
}

const base = {
  pluginId: "dice-check",
  sessionId: "sess-cost",
  turnId: "turn-3",
  logicalTurn: 3,
  locale: "en-US",
  messages,
  world,
};

async function rollTurn({ pluginData = storeOf(), services } = {}) {
  return roller({
    ...base,
    runtimeId: "dice-check/roller",
    random: makeRandom(),
    pluginData,
    ...(services ? { services } : {}),
  });
}

function record(
  checks,
  { plan, checkPlan, dice, pluginData = storeOf(), services },
) {
  return recorder({
    ...base,
    runtimeId: "dice-check/recorder",
    triggerEvent: { topic: "check.resolved", data: { checks } },
    inputs: {
      dicePool: { value: dice },
      checkPlan: { value: checkPlan },
      ...(plan ? { costPlan: { value: plan } } : {}),
    },
    pluginData,
    ...(services ? { services } : {}),
  });
}

const failed = (attribute, outcome = "failure") => ({
  action: "Wade the flooded stretch",
  attribute,
  modifier: 0,
  difficulty: "hard",
  outcome,
});

afterEach(() => forgetPool(base.sessionId, base.turnId));

describe("dice-check costs of failure", () => {
  it("tells the narrative the costs it can pay now, and writes each clock for the panel once", async () => {
    const services = inventory({ "Track chalk": 2 });
    const result = await rollTurn({ services });
    const context = result.value.checkContext;
    expect(context).toContain("## Cost of failure");
    expect(context).toContain(
      "- Stamina, failure or critical failure: Cold water soaks you to the waist. (Cold and wet +2)",
    );
    expect(context).toContain(
      "- Wayfinding, failure or critical failure: You use up a stick of chalk on false marks. (Track chalk −1)",
    );
    // No phone in the bag: a critical failure falls back to the clock.
    expect(context).not.toContain("phone");
    expect(context).toContain(
      "- Any other check, failure or critical failure: The car hears it go wrong. (Panic +1)",
    );
    expect(context).toContain("- Panic: 0/4. When it fills: The car panics.");
    // The plan is for the recorder; it names what it found in the bag.
    expect(result.value.costPlan.held).toEqual({
      "track chalk": 2,
      phone: 0,
    });
    expect(result.value.costPlan.entries.map((entry) => entry.id)).toEqual([
      "soaked",
      "chalk",
      "panic",
    ]);
    expect(result.effects.pluginData.slice(1)).toEqual([
      expect.objectContaining({
        namespace: "clock-progress",
        key: "cold",
        value: expect.objectContaining({ filled: 0, progressText: "0/4" }),
      }),
      expect.objectContaining({ namespace: "clock-progress", key: "panic" }),
    ]);

    // Unchanged clocks are not written again.
    const stored = storeOf({
      "clock-progress": result.effects.pluginData
        .slice(1)
        .map(({ key, value }) => ({ key, value })),
    });
    const again = await rollTurn({ pluginData: stored, services });
    expect(again.effects.pluginData).toHaveLength(1);
  });

  it("leaves item costs out without a bag and says a full clock stays true", async () => {
    const pluginData = storeOf({
      "clock-progress": [
        {
          key: "panic",
          value: {
            id: "panic",
            name: "Panic",
            segments: 4,
            filled: 4,
            progressText: "4/4",
            isFull: true,
            whenFull: "The car panics.",
            fullTurn: 2,
          },
        },
      ],
    });
    const result = await rollTurn({ pluginData });
    const context = result.value.checkContext;
    expect(context).toContain(
      "- Panic: full. The car panics. This stays true for the rest of the story.",
    );
    // Wayfinding has no cost left: its chalk needs a bag, the panic clock is full.
    expect(context).not.toContain("Wayfinding, failure");
    expect(context).not.toContain("Any other check");
    expect(result.value.costPlan.entries.map((entry) => entry.id)).toEqual([
      "soaked",
    ]);
  });

  it("adds nothing when the world gives failure no cost", async () => {
    const result = await rollTurn({
      pluginData: storeOf({ consequences: [] }),
    });
    expect(result.value.costPlan).toBeUndefined();
    expect(result.value.checkContext).not.toContain("Cost of failure");
    expect(result.effects.pluginData).toHaveLength(1);
  });

  it("pays a clock and an item for the failed checks of a receipt, and nothing for a success", async () => {
    const services = inventory({ "Track chalk": 2 });
    const { value } = await rollTurn({ services });
    const result = await record(
      [
        failed("stamina"),
        failed("Wayfinding"),
        {
          ...failed("stamina"),
          outcome: "success",
          difficulty: "easy",
        },
      ],
      {
        plan: value.costPlan,
        checkPlan: value.checkPlan,
        dice: [5, 6, 15],
        services,
      },
    );
    expect(result.outcome).toBe("success");
    const checks = result.effects.pluginData.filter(
      (write) => write.namespace === "checks",
    );
    expect(checks.map(({ value: check }) => check.costDetail)).toEqual([
      "Cold and wet +2 (2/4)",
      "Track chalk −1",
      undefined,
    ]);
    expect(checks[0].value.costText).toBe("Cold water soaks you to the waist.");
    expect(services.call).toHaveBeenLastCalledWith(
      {
        contract: "inventory.change@1",
        input: {
          changes: [{ op: "remove", item: "Track chalk", quantity: 1 }],
        },
      },
      { signal: undefined },
    );
    // The clock is this plugin's own data; the item is the inventory's, and
    // changes only through its write service.
    expect(
      result.effects.pluginData.map((write) => write.namespace).sort(),
    ).toEqual(["checks", "checks", "checks", "clock-progress", "message"]);
    expect(
      result.effects.pluginData.find(
        (write) => write.namespace === "clock-progress",
      ).value,
    ).toMatchObject({ id: "cold", filled: 2, isFull: false });
  });

  it("passes a refused item on to the next cost and fills a clock to full once", async () => {
    // The roller saw the chalk; the narrative gave it away before the receipt.
    const { value } = await rollTurn({
      services: inventory({ "Track chalk": 1 }),
    });
    const services = inventory({});
    const pluginData = storeOf({
      "clock-progress": [
        {
          key: "panic",
          value: {
            id: "panic",
            name: "Panic",
            segments: 4,
            filled: 3,
            progressText: "3/4",
            isFull: false,
            whenFull: "The car panics.",
          },
        },
      ],
    });
    const plan = value.costPlan;
    const result = await record([failed("wayfinding"), failed("wayfinding")], {
      checkPlan: value.checkPlan,
      plan: {
        ...plan,
        clocks: { ...plan.clocks, panic: { ...plan.clocks.panic, filled: 3 } },
      },
      dice: [5, 6],
      pluginData,
      services,
    });
    const checks = result.effects.pluginData.filter(
      (write) => write.namespace === "checks",
    );
    expect(checks[0].value).toMatchObject({
      costDetail: "Panic +1 (4/4)",
      clockFull: "The car panics.",
    });
    // The clock is full now, and nothing else is left to pay.
    expect(checks[1].value.costText).toBeUndefined();
    expect(
      result.effects.pluginData.find(
        (write) => write.namespace === "clock-progress",
      ).value,
    ).toMatchObject({ filled: 4, isFull: true, fullTurn: 3 });
  });

  it("pays nothing and writes nothing when the receipt does not match the dice", async () => {
    const services = inventory({ "Track chalk": 2 });
    const { value } = await rollTurn({ services });
    services.call.mockClear();
    const result = await record(
      [{ ...failed("stamina"), outcome: "success" }],
      {
        plan: value.costPlan,
        checkPlan: value.checkPlan,
        dice: [5],
        services,
      },
    );
    expect(result.outcome).toBe("failed");
    expect(result.effects).toBeUndefined();
    expect(services.call).not.toHaveBeenCalled();
  });
});

describe("dice-check review of the cost in the prose", () => {
  const ctx = {
    sessionId: base.sessionId,
    turnId: base.turnId,
    locale: "en-US",
    runtimeId: "narrator",
  };
  const story = (text) => ({
    output: { segments: [{ kind: "narration", text }] },
    toolCall: { id: "submit", name: "submit-output" },
    toolResults: [],
  });

  const receipt = (checks) => ({ topic: "check.resolved", data: { checks } });

  /** `emit-event` recorded the receipt; a repeat it refused emits nothing. */
  function accept(checks, recorded = true) {
    acceptRecordedReceipt(ctx, {
      toolCall: {
        id: "emit",
        name: "emit-event",
        arguments: JSON.stringify(receipt(checks)),
      },
      result: {
        success: true,
        ...(recorded ? { emittedEvents: [receipt(checks)] } : {}),
      },
    });
  }

  /** A tool of the narrative returned the receipt in its result. */
  function returnFromTool(checks) {
    acceptRecordedReceipt(ctx, {
      toolCall: { id: "resolve", name: "resolve-checks", arguments: "{}" },
      result: { success: true, parsedResult: { events: [receipt(checks)] } },
    });
  }

  async function recordedTurn(checks) {
    await rollTurn({ services: inventory({}) });
    accept(checks);
  }

  it("sends a story back once when it skips the cost of a failed check", async () => {
    await recordedTurn([failed("stamina")]);
    const first = reviewCostProse(
      ctx,
      story("You make it across the dark water."),
    );
    expect(first.replace.correction).toContain(
      "Check 1 (Wade the flooded stretch) failed, and its cost is: Cold water soaks you to the waist.",
    );
    expect(reviewCostProse(ctx, story("You make it across."))).toEqual({
      action: "continue",
    });
  });

  it("accepts a story that shows the cost, and leaves other runtimes and earlier corrections alone", async () => {
    await recordedTurn([failed("stamina")]);
    expect(
      reviewCostProse(
        ctx,
        story("The water is COLD and climbs to your waist."),
      ),
    ).toEqual({ action: "continue" });
    expect(
      reviewCostProse({ ...ctx, runtimeId: "other" }, story("Nothing.")),
    ).toEqual({ action: "continue" });
    expect(
      reviewCostProse(ctx, {
        ...story("Nothing."),
        correction: "Fix the perspective.",
      }),
    ).toEqual({ action: "continue" });
    // Still checked on the next submission.
    expect(reviewCostProse(ctx, story("Nothing."))).toHaveProperty(
      "replace.correction",
    );
  });

  it("does not review a turn whose checks all succeeded", async () => {
    await recordedTurn([{ ...failed("stamina"), outcome: "success" }]);
    expect(reviewCostProse(ctx, story("Nothing."))).toEqual({
      action: "continue",
    });
  });

  it("reviews the accepted receipt, not the payload of a successful duplicate no-op", async () => {
    await recordedTurn([failed("stamina")]);
    accept([{ ...failed("stamina"), outcome: "success" }], false);
    expect(reviewCostProse(ctx, story("Nothing."))).toHaveProperty(
      "replace.correction",
      expect.stringContaining("Cold water soaks you to the waist"),
    );
  });

  // The recorder gets the event the kernel delivers: a tool result's event
  // comes before an emitted one, whichever was sent first.
  it.each([
    {
      order: "a tool result after an emitted receipt",
      send: (emitted, returned) => {
        accept(emitted);
        returnFromTool(returned);
      },
    },
    {
      order: "a tool result before an emitted receipt",
      send: (emitted, returned) => {
        returnFromTool(returned);
        accept(emitted);
      },
    },
  ])("reviews the receipt the recorder settles: $order", async ({ send }) => {
    await rollTurn({ services: inventory({}) });
    send([{ ...failed("stamina"), outcome: "success" }], [failed("stamina")]);
    expect(reviewCostProse(ctx, story("Nothing."))).toHaveProperty(
      "replace.correction",
      expect.stringContaining("Cold water soaks you to the waist"),
    );
    forgetPool(base.sessionId, base.turnId);

    await rollTurn({ services: inventory({}) });
    send([failed("stamina")], [{ ...failed("stamina"), outcome: "success" }]);
    expect(reviewCostProse(ctx, story("Nothing."))).toEqual({
      action: "continue",
    });
  });
});
