import { describe, expect, it, vi } from "vitest";
import handler from "../runtimes/recorder/handler.js";
import { loadPluginMessages } from "@covel/plugin-test-utils";

// What the host gives a handler as `ctx.messages`: this plugin's translations.
const messages = await loadPluginMessages(
  new URL("..", import.meta.url),
  "zh-CN",
);

const TOPIC = "check.resolved";

// What the narrative reports: its decisions and the outcome it wrote. The
// die, the DC and the total are the recorder's.
const VALID_CHECK = {
  action: "撬开地窖的铜锁",
  attribute: "敏捷",
  modifier: 3,
  difficulty: "normal",
  outcome: "success",
};

function makeCtx({
  data,
  noTriggerEvent = false,
  existingCheckRows = [],
  existingMessage = null,
  dice = [14, 6, 20],
  tabletopReceipt = undefined,
  logicalTurn = undefined,
  world = undefined,
} = {}) {
  return {
    pluginId: "dice-check",
    runtimeId: "dice-check/recorder",
    messages,
    locale: "zh-CN",
    sessionId: "sess-1",
    turnId: "turn-7",
    ...(logicalTurn === undefined ? {} : { logicalTurn }),
    ...(world === undefined ? {} : { world }),
    triggerEvent: noTriggerEvent ? undefined : { topic: TOPIC, data },
    inputs: {
      ...(dice === null
        ? {}
        : {
            dicePool: {
              value: dice,
              source: { runtimeId: "dice-check/roller" },
            },
          }),
      ...(tabletopReceipt === undefined
        ? {}
        : { tabletopCheck: { value: tabletopReceipt } }),
    },
    pluginData: {
      get: vi.fn(async (namespace, key) => {
        if (namespace === "message" && key === "turn-7") return existingMessage;
        return null;
      }),
      list: vi.fn(async (namespace) =>
        namespace === "checks" ? existingCheckRows : [],
      ),
      set: vi.fn(),
      delete: vi.fn(),
    },
  };
}

describe("dice-check recorder handler", () => {
  it("skips a submitted tabletop check even when its die occurs later in the dice pool", async () => {
    const ctx = makeCtx({
      data: {
        checks: [
          {
            action: "Check the receiver wiring for a loose connection",
            attribute: "systems",
            modifier: 4,
            difficulty: "normal",
            outcome: "success",
          },
        ],
      },
      dice: [18, 12, 20],
      tabletopReceipt: {
        resolvedTurnId: "turn-7",
        die: 12,
        modifier: 4,
        difficulty: 12,
        total: 16,
        outcome: "success",
      },
    });

    const result = await handler(ctx);
    expect(result).toMatchObject({ outcome: "skipped" });
    expect(ctx.pluginData.get).not.toHaveBeenCalled();
    expect(result.effects).toBeUndefined();
  });

  it("records an ordinary dice-pool action when the tabletop receipt is from a previous turn", async () => {
    const ctx = makeCtx({
      data: { checks: [VALID_CHECK] },
      tabletopReceipt: { resolvedTurnId: "turn-6", die: 12 },
    });

    const result = await handler(ctx);
    expect(result.outcome).toBe("success");
    expect(
      result.effects.pluginData.find((row) => row.namespace === "checks").value
        .roll,
    ).toBe(14);
  });

  it("records an ordinary dice-pool action when tabletop has no submitted receipt", async () => {
    const ctx = makeCtx({
      data: { checks: [VALID_CHECK] },
      tabletopReceipt: null,
    });

    const result = await handler(ctx);
    expect(result.outcome).toBe("success");
    expect(
      result.effects.pluginData.find((row) => row.namespace === "checks").value
        .roll,
    ).toBe(14);
  });

  it("records a valid batched receipt into the checks namespace with a turn-scoped sequence key", async () => {
    // Arrange
    const ctx = makeCtx({ data: { checks: [VALID_CHECK] } });

    // Act
    const result = await handler(ctx);

    // Assert
    const checksRow = result.effects.pluginData.find(
      (r) => r.namespace === "checks",
    );
    expect(checksRow.key).toBe("turn-7-1");
    expect(checksRow.value).toMatchObject({
      action: "撬开地窖的铜锁",
      attribute: "敏捷",
      roll: 14,
      modifier: 3,
      dc: 12,
      difficulty: "normal",
      total: 17,
      outcome: "success",
      turnId: "turn-7",
      seq: 1,
      outcomeColor: "green",
      critical: false,
      rollText: "14 + 3 = 17 vs DC 12",
    });
  });

  it("names the check's turn by its number in every shipped language, keeping the turn ID for code", async () => {
    const ctx = makeCtx({ data: { checks: [VALID_CHECK] }, logicalTurn: 7 });

    const result = await handler(ctx);

    const checksRow = result.effects.pluginData.find(
      (r) => r.namespace === "checks",
    );
    expect(checksRow.key).toBe("turn-7-1");
    expect(checksRow.value).toMatchObject({
      turnId: "turn-7",
      turn: 7,
      turnLabel: { en: "Turn 7", zh: "第 7 回合" },
    });
  });

  it("gives no turn label when the host gives no logical turn", async () => {
    const result = await handler(makeCtx({ data: { checks: [VALID_CHECK] } }));

    const check = result.effects.pluginData.find(
      (r) => r.namespace === "checks",
    ).value;
    expect(check).not.toHaveProperty("turn");
    expect(check).not.toHaveProperty("turnLabel");
  });

  it("shows the world's name of the attribute a receipt gives by id or by name", async () => {
    const world = {
      characters: [],
      characterSchema: {
        attributes: [
          {
            id: "agility",
            name: "敏捷",
            type: "number",
            category: "abilities",
            min: 0,
            max: 5,
          },
          { id: "trust", name: "信任", type: "number", category: "social" },
        ],
      },
    };
    const labelOf = async (attribute) => {
      const result = await handler(
        makeCtx({ data: { checks: [{ ...VALID_CHECK, attribute }] }, world }),
      );
      const check = result.effects.pluginData.find(
        (r) => r.namespace === "checks",
      ).value;
      // The receipt's own text stays on record.
      expect(check.attribute).toBe(attribute);
      // The message block shows the same label as the log.
      expect(
        result.effects.pluginData.find((r) => r.namespace === "message").value
          .checks[0].attributeLabel,
      ).toBe(check.attributeLabel);
      return check.attributeLabel;
    };

    expect(await labelOf("agility")).toBe("敏捷");
    expect(await labelOf("Agility")).toBe("敏捷");
    expect(await labelOf("敏捷")).toBe("敏捷");
    expect(await labelOf("trust")).toBe("信任");
    // Text that names no attribute of the world is shown as written.
    expect(await labelOf("运气")).toBe("运气");
  });

  it("resolves an attribute name written in several languages for the session", async () => {
    const world = {
      characters: [],
      characterSchema: {
        attributes: [
          {
            id: "agility",
            name: { "zh-CN": "敏捷", "en-US": "Agility" },
            type: "number",
            category: "abilities",
            max: 5,
          },
        ],
      },
    };
    const result = await handler(
      makeCtx({
        data: { checks: [{ ...VALID_CHECK, attribute: "Agility" }] },
        world,
      }),
    );
    expect(
      result.effects.pluginData.find((r) => r.namespace === "checks").value
        .attributeLabel,
    ).toBe("敏捷");
  });

  it("records a zero-modifier receipt without an attribute label", async () => {
    const ctx = makeCtx({
      data: {
        checks: [
          {
            action: "撬开地窖的铜锁",
            modifier: 0,
            difficulty: "normal",
            outcome: "success",
          },
        ],
      },
    });

    const result = await handler(ctx);

    expect(result.outcome).toBe("success");
    const check = result.effects.pluginData.find(
      (row) => row.namespace === "checks",
    ).value;
    expect(check).toMatchObject({
      action: "撬开地窖的铜锁",
      modifier: 0,
      roll: 14,
      total: 14,
      outcome: "success",
    });
    expect(check).not.toHaveProperty("attribute");
    expect(check).not.toHaveProperty("attributeLabel");
    const message = result.effects.pluginData.find(
      (row) => row.namespace === "message",
    ).value;
    expect(message.checks).toEqual([check]);
    expect(message.rejectedCount).toBe(0);
  });

  it("records every check of a multi-check batch with consecutive sequence keys", async () => {
    // Arrange
    // The second check of the turn uses the second die, a 6.
    const second = {
      action: "缒链下降",
      modifier: 1,
      difficulty: "normal",
      outcome: "failure",
    };
    const ctx = makeCtx({ data: { checks: [VALID_CHECK, second] } });

    // Act
    const result = await handler(ctx);

    // Assert
    const checkRows = result.effects.pluginData.filter(
      (r) => r.namespace === "checks",
    );
    expect(checkRows.map((r) => r.key)).toEqual(["turn-7-1", "turn-7-2"]);
    const messageRow = result.effects.pluginData.find(
      (r) => r.namespace === "message",
    );
    expect(messageRow.value.checks).toHaveLength(2);
    expect(messageRow.value.checks[1].outcomeColor).toBe("red");
  });

  it("appends the receipt to this turn's message-block array with the turn binding", async () => {
    // Arrange
    const ctx = makeCtx({ data: { checks: [VALID_CHECK] } });

    // Act
    const result = await handler(ctx);

    // Assert
    const messageRow = result.effects.pluginData.find(
      (r) => r.namespace === "message",
    );
    expect(messageRow.key).toBe("turn-7");
    expect(messageRow.value.__turnId).toBe("turn-7");
    expect(messageRow.value.checks).toHaveLength(1);
    // Every language the plugin ships: the block picks the UI language.
    expect(messageRow.value.checks[0].outcomeLabel).toEqual({
      en: "Success",
      zh: "成功",
    });
  });

  it("increments the sequence and appends when the turn already has a recorded check", async () => {
    // Arrange
    const earlier = { action: "先前的判定", seq: 1 };
    const ctx = makeCtx({
      data: {
        checks: [
          // One check is on record, so this one uses the second die, a 14.
          { ...VALID_CHECK, modifier: -3, outcome: "failure" },
        ],
      },
      existingCheckRows: [
        { key: "turn-7-1", value: earlier },
        { key: "turn-3-1", value: {} },
      ],
      existingMessage: { __turnId: "turn-7", checks: [earlier] },
      dice: [3, 14, 20],
    });

    // Act
    const result = await handler(ctx);

    // Assert
    const checksRow = result.effects.pluginData.find(
      (r) => r.namespace === "checks",
    );
    expect(checksRow.key).toBe("turn-7-2");
    const messageRow = result.effects.pluginData.find(
      (r) => r.namespace === "message",
    );
    expect(messageRow.value.checks).toHaveLength(2);
    expect(messageRow.value.checks[1].outcomeColor).toBe("red");
  });

  it("flags critical outcomes for UI emphasis", async () => {
    // Arrange
    const ctx = makeCtx({
      data: {
        checks: [{ ...VALID_CHECK, outcome: "critical-success" }],
      },
      dice: [20, 6, 8],
    });

    // Act
    const result = await handler(ctx);

    // Assert
    const checksRow = result.effects.pluginData.find(
      (r) => r.namespace === "checks",
    );
    expect(checksRow.value.critical).toBe(true);
    expect(checksRow.value.outcomeColor).toBe("purple");
  });

  it("drops an invalid batch item, and the next check keeps its own die", async () => {
    // Arrange — the first item has no modifier. It still was the first check
    // of the turn, so the second item is judged by the second die, a 6.
    const { modifier: _dropped, ...withoutModifier } = VALID_CHECK;
    const second = { ...VALID_CHECK, action: "缒链下降", outcome: "failure" };
    const ctx = makeCtx({ data: { checks: [withoutModifier, second] } });

    // Act
    const result = await handler(ctx);

    // Assert
    const checkRows = result.effects.pluginData.filter(
      (r) => r.namespace === "checks",
    );
    expect(checkRows).toHaveLength(1);
    expect(checkRows[0].value).toMatchObject({
      action: "缒链下降",
      roll: 6,
      total: 9,
      outcome: "failure",
    });
    expect(
      result.effects.pluginData.find((r) => r.namespace === "message").value
        .rejectedCount,
    ).toBe(1);
  });

  it("takes the die from the pool, whatever a receipt says about it", async () => {
    // A receipt cannot choose its die: the first check uses the first die.
    const ctx = makeCtx({
      data: { checks: [{ ...VALID_CHECK, roll: 20, dc: 8, total: 23 }] },
    });

    const result = await handler(ctx);

    expect(
      result.effects.pluginData.find((r) => r.namespace === "checks").value,
    ).toMatchObject({ roll: 14, dc: 12, total: 17, outcome: "success" });
  });

  it("reports failure when every batch item misses a required field", async () => {
    // Arrange
    const { modifier: _dropped, ...withoutModifier } = VALID_CHECK;
    const ctx = makeCtx({ data: { checks: [withoutModifier] } });

    // Act
    const result = await handler(ctx);

    // Assert
    expect(result.outcome).toBe("failed");
    expect(result.effects?.pluginData).toBeUndefined();
  });

  it("reports failure when outcome is not a known value", async () => {
    // Arrange
    const ctx = makeCtx({
      data: { checks: [{ ...VALID_CHECK, outcome: "maybe" }] },
    });

    // Act
    const result = await handler(ctx);

    // Assert
    expect(result.outcome).toBe("failed");
    expect(result.effects?.pluginData).toBeUndefined();
  });

  it("skips gracefully when there is no trigger event at all", async () => {
    // Arrange
    const ctx = makeCtx({ noTriggerEvent: true });

    // Act
    const result = await handler(ctx);

    // Assert
    expect(result.outcome).toBe("skipped");
    expect(result.effects?.pluginData).toBeUndefined();
  });

  it("skips a bare check outside the current checks-array contract", async () => {
    const result = await handler(makeCtx({ data: VALID_CHECK }));
    expect(result.outcome).toBe("skipped");
    expect(result.effects?.pluginData).toBeUndefined();
  });

  it("ignores wrapped plugin-data reads while accepting the stored value directly", async () => {
    const wrapped = makeCtx({ data: { checks: [VALID_CHECK] }, dice: null });
    wrapped.pluginData.get.mockImplementation(async () => ({
      value: { dice: [14] },
    }));
    expect((await handler(wrapped)).outcome).toBe("failed");
    const direct = makeCtx({ data: { checks: [VALID_CHECK] }, dice: null });
    direct.pluginData.get.mockImplementation(async (namespace) =>
      namespace === "rolls"
        ? { dice: [14] }
        : { value: { checks: [VALID_CHECK] } },
    );
    const result = await handler(direct);
    expect(result.outcome).toBe("success");
    expect(
      result.effects.pluginData.find((row) => row.namespace === "message").value
        .checks,
    ).toHaveLength(1);
  });

  it("rejects malformed consistency fields instead of storing an unverifiable receipt", async () => {
    const ctx = makeCtx({
      data: {
        checks: [
          {
            action: "说服守卫",
            outcome: "failure",
            modifier: "3",
            difficulty: "impossible",
          },
        ],
      },
    });

    // Act
    const result = await handler(ctx);

    // Assert
    expect(result.outcome).toBe("failed");
    expect(result.effects?.pluginData).toBeUndefined();
  });

  it.each([
    // The first die is a 14: with +3 against DC 12 the outcome is success.
    ["an outcome that the die does not give", { outcome: "failure" }],
    [
      "a critical outcome that the die did not roll",
      { outcome: "critical-success" },
    ],
    ["a modifier that is not an attribute modifier", { modifier: 11 }],
    ["an unknown difficulty", { difficulty: "legendary" }],
  ])("rejects %s", async (_label, patch) => {
    const ctx = makeCtx({
      data: { checks: [{ ...VALID_CHECK, ...patch }] },
    });

    const result = await handler(ctx);
    expect(result.outcome).toBe("failed");
    expect(result.effects?.pluginData).toBeUndefined();
  });

  it("fails closed when the pre-rolled audit row is missing", async () => {
    const ctx = makeCtx({ data: { checks: [VALID_CHECK] }, dice: null });
    const result = await handler(ctx);
    expect(result.outcome).toBe("failed");
  });

  it("fails closed without shifting positions when the dice pool is malformed", async () => {
    const ctx = makeCtx({
      data: { checks: [VALID_CHECK] },
      dice: [99, 14],
    });
    const result = await handler(ctx);
    expect(result.outcome).toBe("failed");
  });

  it("uses the same-execution roller output before pluginData commits", async () => {
    const ctx = makeCtx({ data: { checks: [VALID_CHECK] } });

    const result = await handler(ctx);

    expect(result.outcome).toBe("success");
    expect(ctx.pluginData.get).not.toHaveBeenCalledWith("rolls", "turn-7");
  });
});
