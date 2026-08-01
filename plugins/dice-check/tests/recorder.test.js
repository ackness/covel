import { describe, expect, it, vi } from "vitest";
import handler from "../runtimes/recorder/handler.js";

const TOPIC = "check.resolved";

const VALID_CHECK = {
  action: "撬开地窖的铜锁",
  attribute: "敏捷",
  roll: 14,
  modifier: 3,
  dc: 12,
  difficulty: "normal",
  total: 17,
  outcome: "success",
};

function makeCtx({
  data,
  noTriggerEvent = false,
  existingCheckRows = [],
  existingMessage = null,
} = {}) {
  return {
    pluginId: "dice-check",
    runtimeId: "dice-check/recorder",
    sessionId: "sess-1",
    turnId: "turn-7",
    triggerEvent: noTriggerEvent ? undefined : { topic: TOPIC, data },
    pluginData: {
      get: vi.fn(async (namespace, key) =>
        namespace === "message" && key === "turn-7" ? existingMessage : null,
      ),
      list: vi.fn(async (namespace) =>
        namespace === "checks" ? existingCheckRows : [],
      ),
      set: vi.fn(),
      delete: vi.fn(),
    },
  };
}

describe("dice-check recorder handler", () => {
  it("records a valid batched receipt into the checks namespace with a turn-scoped sequence key", async () => {
    // Arrange
    const ctx = makeCtx({ data: { checks: [VALID_CHECK] } });

    // Act
    const result = await handler(ctx);

    // Assert
    const checksRow = result.pluginData.find((r) => r.namespace === "checks");
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

  it("records every check of a multi-check batch with consecutive sequence keys", async () => {
    // Arrange
    const second = {
      action: "缒链下降",
      roll: 6,
      modifier: 1,
      dc: 12,
      total: 7,
      outcome: "failure",
    };
    const ctx = makeCtx({ data: { checks: [VALID_CHECK, second] } });

    // Act
    const result = await handler(ctx);

    // Assert
    const checkRows = result.pluginData.filter((r) => r.namespace === "checks");
    expect(checkRows.map((r) => r.key)).toEqual(["turn-7-1", "turn-7-2"]);
    const messageRow = result.pluginData.find((r) => r.namespace === "message");
    expect(messageRow.value.checks).toHaveLength(2);
    expect(messageRow.value.checks[1].outcomeColor).toBe("red");
  });

  it("appends the receipt to this turn's message-block array with the turn binding", async () => {
    // Arrange
    const ctx = makeCtx({ data: { checks: [VALID_CHECK] } });

    // Act
    const result = await handler(ctx);

    // Assert
    const messageRow = result.pluginData.find((r) => r.namespace === "message");
    expect(messageRow.key).toBe("turn-7");
    expect(messageRow.value.__turnId).toBe("turn-7");
    expect(messageRow.value.checks).toHaveLength(1);
    expect(messageRow.value.checks[0].outcomeLabel).toEqual({
      zh: "成功",
      en: "Success",
    });
  });

  it("increments the sequence and appends when the turn already has a recorded check", async () => {
    // Arrange
    const earlier = { action: "先前的判定", seq: 1 };
    const ctx = makeCtx({
      data: { checks: [{ ...VALID_CHECK, outcome: "failure" }] },
      existingCheckRows: [
        { key: "turn-7-1", value: earlier },
        { key: "turn-3-1", value: {} },
      ],
      existingMessage: { __turnId: "turn-7", checks: [earlier] },
    });

    // Act
    const result = await handler(ctx);

    // Assert
    const checksRow = result.pluginData.find((r) => r.namespace === "checks");
    expect(checksRow.key).toBe("turn-7-2");
    const messageRow = result.pluginData.find((r) => r.namespace === "message");
    expect(messageRow.value.checks).toHaveLength(2);
    expect(messageRow.value.checks[1].outcomeColor).toBe("red");
  });

  it("flags critical outcomes for UI emphasis", async () => {
    // Arrange
    const ctx = makeCtx({
      data: {
        checks: [
          { ...VALID_CHECK, roll: 20, total: 23, outcome: "critical-success" },
        ],
      },
    });

    // Act
    const result = await handler(ctx);

    // Assert
    const checksRow = result.pluginData.find((r) => r.namespace === "checks");
    expect(checksRow.value.critical).toBe(true);
    expect(checksRow.value.outcomeColor).toBe("purple");
  });

  it("drops invalid batch items but records the valid ones", async () => {
    // Arrange — first item lacks roll, second is fine
    const { roll: _dropped, ...withoutRoll } = VALID_CHECK;
    const ctx = makeCtx({ data: { checks: [withoutRoll, VALID_CHECK] } });

    // Act
    const result = await handler(ctx);

    // Assert
    const checkRows = result.pluginData.filter((r) => r.namespace === "checks");
    expect(checkRows).toHaveLength(1);
    expect(checkRows[0].value.action).toBe("撬开地窖的铜锁");
  });

  it("skips gracefully when every batch item misses a required field", async () => {
    // Arrange
    const { roll: _dropped, ...withoutRoll } = VALID_CHECK;
    const ctx = makeCtx({ data: { checks: [withoutRoll] } });

    // Act
    const result = await handler(ctx);

    // Assert
    expect(result.status).toBe("skipped");
    expect(result.pluginData).toBeUndefined();
  });

  it("skips gracefully when outcome is not a known value", async () => {
    // Arrange
    const ctx = makeCtx({
      data: { checks: [{ ...VALID_CHECK, outcome: "maybe" }] },
    });

    // Act
    const result = await handler(ctx);

    // Assert
    expect(result.status).toBe("skipped");
    expect(result.pluginData).toBeUndefined();
  });

  it("skips gracefully when there is no trigger event at all", async () => {
    // Arrange
    const ctx = makeCtx({ noTriggerEvent: true });

    // Act
    const result = await handler(ctx);

    // Assert
    expect(result.status).toBe("skipped");
    expect(result.pluginData).toBeUndefined();
  });

  it("tolerates a bare single-check payload without the checks wrapper", async () => {
    // Arrange — schema forbids this shape, but a hand-made event should
    // degrade to "one check" instead of a skip
    const ctx = makeCtx({ data: VALID_CHECK });

    // Act
    const result = await handler(ctx);

    // Assert
    const checksRow = result.pluginData.find((r) => r.namespace === "checks");
    expect(checksRow.key).toBe("turn-7-1");
    expect(checksRow.value.outcome).toBe("success");
  });

  it("drops malformed optional fields instead of failing the receipt", async () => {
    // Arrange — modifier as string, dc as float, unknown difficulty
    const ctx = makeCtx({
      data: {
        checks: [
          {
            action: "说服守卫",
            roll: 9,
            total: 9,
            outcome: "failure",
            modifier: "3",
            dc: 12.5,
            difficulty: "impossible",
          },
        ],
      },
    });

    // Act
    const result = await handler(ctx);

    // Assert
    const checksRow = result.pluginData.find((r) => r.namespace === "checks");
    expect(checksRow.value.modifier).toBeUndefined();
    expect(checksRow.value.dc).toBeUndefined();
    expect(checksRow.value.difficulty).toBeUndefined();
    expect(checksRow.value.rollText).toBe("9 = 9");
  });
});
