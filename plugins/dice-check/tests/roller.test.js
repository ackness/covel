import { describe, expect, it } from "vitest";
import { makeRandom } from "@covel/plugin-test-utils";
import handler from "../runtimes/roller/handler.js";
import { poolOf } from "../lib/turn-pool.js";

function makeCtx(overrides = {}) {
  return {
    pluginId: "dice-check",
    runtimeId: "dice-check/roller",
    sessionId: "sess-1",
    turnId: "turn-1",
    playerMessage: "",
    random: makeRandom(),
    ...overrides,
  };
}

describe("dice-check roller handler", () => {
  it("takes its dice from the host's ctx.random", async () => {
    const drawn = [17, 2, 20];
    const ranges = [];
    const random = {
      int(min, max) {
        ranges.push([min, max]);
        return drawn[ranges.length - 1];
      },
    };

    const result = await handler(makeCtx({ random }));

    expect(result.value.dice).toEqual([17, 2, 20]);
    expect(ranges).toEqual([
      [1, 21],
      [1, 21],
      [1, 21],
    ]);
  });

  it("rolls exactly three d20 values within 1..20", async () => {
    // Arrange — repeat to exercise the RNG bounds, not just one lucky draw
    const rolls = [];

    // Act
    for (let i = 0; i < 30; i += 1) {
      const result = await handler(makeCtx());
      rolls.push(result.effects.pluginData[0].value.dice);
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
    const ctx = makeCtx({ locale: "zh-CN" });

    // Act
    const result = await handler(ctx);

    // Assert
    expect(typeof result.value.checkContext).toBe("string");
    expect(result.value.checkContext.length).toBeGreaterThan(0);
    expect(result.value.checkContext).toContain("check.resolved");
    expect(result.value.checkContext).toContain("DC");
    expect(result.value.checkContext).toContain("大成功");
    expect(result.value.checkContext).toContain("大失败");
  });

  it("gives each check one row with its die and the outcome at every difficulty", async () => {
    // Arrange
    const ctx = makeCtx({ locale: "en-US" });

    // Act
    const result = await handler(ctx);

    // Assert
    const { dice } = result.effects.pluginData[0].value;
    const rows = result.value.checkContext
      .split("\n")
      .filter((line) => /^\| \d \|/.test(line));
    expect(rows).toHaveLength(3);
    dice.forEach((value, index) => {
      const cells = rows[index].split("|").map((cell) => cell.trim());
      expect(cells.slice(1, 3)).toEqual([`${index + 1}`, `${value}`]);
      // easy, normal, hard, extreme: the narrative reads, it does not add.
      const expected = [8, 12, 16, 20].map((dc) => {
        if (value === 20) return "critical success";
        if (value === 1) return "critical failure";
        const needed = dc - value;
        if (needed <= -10) return "success";
        if (needed > 10) return "failure";
        return `success if modifier is ${needed > 0 ? `+${needed}` : needed} or more, else failure`;
      });
      expect(cells.slice(3, 7)).toEqual(expected);
    });
  });

  it("keeps the turn's dice for the guard that checks the receipt", async () => {
    const result = await handler(makeCtx({ turnId: "turn-guard" }));
    expect(poolOf("sess-1", "turn-guard")).toEqual(
      result.effects.pluginData[0].value.dice,
    );
  });

  it("gives no dice table in a turn that a tabletop form settled", async () => {
    const result = await handler(
      makeCtx({
        turnId: "turn-owned",
        locale: "en-US",
        inputs: { tabletopCheck: { value: { resolvedTurnId: "turn-owned" } } },
      }),
    );

    expect(result.value.checkContext).toContain("Do not make a dice check");
    expect(result.value.checkContext).not.toContain("| check |");
    // The dice are still rolled and recorded; the guard does not get them.
    expect(result.value.dice).toHaveLength(3);
    expect(poolOf("sess-1", "turn-owned")).toBeUndefined();

    // A receipt of an earlier turn does not own this one.
    const next = await handler(
      makeCtx({
        turnId: "turn-next",
        locale: "en-US",
        inputs: { tabletopCheck: { value: { resolvedTurnId: "turn-owned" } } },
      }),
    );
    expect(next.value.checkContext).toContain("| check |");
  });

  it("writes the raw dice pool to the rolls namespace keyed by turnId", async () => {
    // Arrange
    const ctx = makeCtx({ turnId: "turn-42" });

    // Act
    const result = await handler(ctx);

    // Assert
    expect(result.effects.pluginData).toHaveLength(1);
    const [row] = result.effects.pluginData;
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
    expect(result.value.checkContext).toContain("critical success");
    expect(result.value.checkContext).toContain("check.resolved");
    expect(result.value.checkContext).not.toContain("大成功");
  });

  it("uses English rules for non-default and Traditional Chinese locales", async () => {
    for (const locale of ["ru-RU", "ja-JP", "zh-Hant-TW", "zh-TW"]) {
      const result = await handler(makeCtx({ locale }));
      expect(result.value.checkContext).toContain("critical success");
      expect(result.value.checkContext).not.toContain("大成功");
    }

    const simplified = await handler(makeCtx({ locale: "zh-Hans" }));
    expect(simplified.value.checkContext).toContain("大成功");
  });
});
