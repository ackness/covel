import { describe, expect, it } from "vitest";
import handler from "../runtimes/roller/handler.js";

function makeCtx(overrides = {}) {
  return {
    pluginId: "dice-check",
    runtimeId: "dice-check/roller",
    sessionId: "sess-1",
    turnId: "turn-1",
    playerMessage: "",
    ...overrides,
  };
}

describe("dice-check roller handler", () => {
  it("rolls exactly three d20 values within 1..20", async () => {
    // Arrange — repeat to exercise the RNG bounds, not just one lucky draw
    const rolls = [];

    // Act
    for (let i = 0; i < 30; i += 1) {
      const result = await handler(makeCtx());
      rolls.push(result.pluginData[0].value.dice);
    }

    // Assert
    for (const dice of rolls) {
      expect(dice).toHaveLength(3);
      for (const value of dice) {
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(1);
        expect(value).toBeLessThanOrEqual(20);
      }
    }
  });

  it("returns a non-empty checkContext containing the check rules", async () => {
    // Arrange
    const ctx = makeCtx();

    // Act
    const result = await handler(ctx);

    // Assert
    expect(typeof result.checkContext).toBe("string");
    expect(result.checkContext.length).toBeGreaterThan(0);
    expect(result.checkContext).toContain("check.resolved");
    expect(result.checkContext).toContain("DC");
    expect(result.checkContext).toContain("大成功");
    expect(result.checkContext).toContain("大失败");
  });

  it("lists every rolled die in the checkContext pool", async () => {
    // Arrange
    const ctx = makeCtx();

    // Act
    const result = await handler(ctx);

    // Assert
    const { dice } = result.pluginData[0].value;
    dice.forEach((value, index) => {
      expect(result.checkContext).toContain(`#${index + 1}: ${value}`);
    });
  });

  it("writes the raw dice pool to the rolls namespace keyed by turnId", async () => {
    // Arrange
    const ctx = makeCtx({ turnId: "turn-42" });

    // Act
    const result = await handler(ctx);

    // Assert
    expect(result.pluginData).toHaveLength(1);
    const [row] = result.pluginData;
    expect(row.namespace).toBe("rolls");
    expect(row.key).toBe("turn-42");
    expect(row.value.dice).toHaveLength(3);
  });

  it("renders English rules when the session locale is en-US", async () => {
    // Arrange
    const ctx = makeCtx({ locale: "en-US" });

    // Act
    const result = await handler(ctx);

    // Assert
    expect(result.checkContext).toContain("critical success");
    expect(result.checkContext).toContain("check.resolved");
    expect(result.checkContext).not.toContain("大成功");
  });
});
