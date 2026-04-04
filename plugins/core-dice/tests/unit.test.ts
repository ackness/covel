import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parseExpression,
  rollDice,
  rollCheck,
  getDifficultyClass,
  rollSingleDie,
} from "../server/dice-engine.js";
import type {
  CheckResult,
  PercentageCheckResult,
} from "../server/dice-engine.js";
import { rollCheckTool, rollDiceTool } from "../server/tools.js";
import { diceContextProvider } from "../server/context-provider.js";
import { validateManifest } from "@covel/plugin-runtime";
import type { ToolExecutionContext } from "@covel/shared";
import type { ContextProviderInput } from "@covel/plugin-runtime";

// ── plugin.json manifest ────────────────────────────────────────

describe("plugin.json manifest", () => {
  it("passes schema validation", () => {
    const raw = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../plugin.json"), "utf-8"),
    );
    const result = validateManifest(raw);
    if (!result.ok) {
      throw new Error(
        `Manifest validation failed:\n${result.errors.map((e) => `  - ${e}`).join("\n")}`,
      );
    }
    expect(result.ok).toBe(true);
  });
});

// ── parseExpression ───────────────────────────────────────────────

describe("parseExpression", () => {
  it("parses simple expression: 2d6+3", () => {
    const result = parseExpression("2d6+3");
    expect(result).toEqual({ count: 2, sides: 6, modifier: 3 });
  });

  it("parses expression without count: d20", () => {
    const result = parseExpression("d20");
    expect(result).toEqual({ count: 1, sides: 20, modifier: 0 });
  });

  it("parses expression: 1d20", () => {
    const result = parseExpression("1d20");
    expect(result).toEqual({ count: 1, sides: 20, modifier: 0 });
  });

  it("parses d100", () => {
    const result = parseExpression("d100");
    expect(result).toEqual({ count: 1, sides: 100, modifier: 0 });
  });

  it("parses negative modifier: 3d8-2", () => {
    const result = parseExpression("3d8-2");
    expect(result).toEqual({ count: 3, sides: 8, modifier: -2 });
  });

  it("handles whitespace", () => {
    const result = parseExpression("  2d6+1  ");
    expect(result).toEqual({ count: 2, sides: 6, modifier: 1 });
  });

  it("is case-insensitive", () => {
    const result = parseExpression("2D6+3");
    expect(result).toEqual({ count: 2, sides: 6, modifier: 3 });
  });

  it("throws on invalid expression", () => {
    expect(() => parseExpression("abc")).toThrow("Invalid dice expression");
    expect(() => parseExpression("")).toThrow("Invalid dice expression");
    expect(() => parseExpression("2d")).toThrow("Invalid dice expression");
  });

  it("throws on out-of-range count", () => {
    expect(() => parseExpression("0d6")).toThrow("Dice count must be between");
    expect(() => parseExpression("101d6")).toThrow(
      "Dice count must be between"
    );
  });

  it("throws on out-of-range sides", () => {
    expect(() => parseExpression("1d1")).toThrow("Dice sides must be between");
    expect(() => parseExpression("1d1001")).toThrow(
      "Dice sides must be between"
    );
  });
});

// ── rollSingleDie ─────────────────────────────────────────────────

describe("rollSingleDie", () => {
  it("returns a value between 1 and sides", () => {
    for (let i = 0; i < 100; i++) {
      const result = rollSingleDie(20);
      expect(result).toBeGreaterThanOrEqual(1);
      expect(result).toBeLessThanOrEqual(20);
    }
  });

  it("returns a value between 1 and 6 for d6", () => {
    for (let i = 0; i < 100; i++) {
      const result = rollSingleDie(6);
      expect(result).toBeGreaterThanOrEqual(1);
      expect(result).toBeLessThanOrEqual(6);
    }
  });
});

// ── rollDice ──────────────────────────────────────────────────────

describe("rollDice", () => {
  it("returns correct number of individual rolls", () => {
    const result = rollDice("3d6");
    expect(result.rolls).toHaveLength(3);
    expect(result.expression).toBe("3d6");
    expect(result.modifier).toBe(0);
  });

  it("applies modifier correctly", () => {
    const result = rollDice("1d6+5");
    expect(result.rolls).toHaveLength(1);
    expect(result.modifier).toBe(5);
    expect(result.total).toBe(result.rolls[0]! + 5);
  });

  it("applies negative modifier", () => {
    const result = rollDice("2d6-1");
    expect(result.modifier).toBe(-1);
    const sum = result.rolls.reduce((a, b) => a + b, 0);
    expect(result.total).toBe(sum - 1);
  });

  it("returns frozen result", () => {
    const result = rollDice("1d20");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.rolls)).toBe(true);
  });

  it("all individual rolls are within valid range", () => {
    const result = rollDice("5d10+2");
    for (const roll of result.rolls) {
      expect(roll).toBeGreaterThanOrEqual(1);
      expect(roll).toBeLessThanOrEqual(10);
    }
  });
});

// ── getDifficultyClass ────────────────────────────────────────────

describe("getDifficultyClass", () => {
  it("returns correct DC for all difficulty levels", () => {
    expect(getDifficultyClass("easy")).toBe(8);
    expect(getDifficultyClass("medium")).toBe(12);
    expect(getDifficultyClass("hard")).toBe(16);
    expect(getDifficultyClass("very_hard")).toBe(20);
    expect(getDifficultyClass("legendary")).toBe(24);
  });

  it("throws on unknown difficulty", () => {
    expect(() => getDifficultyClass("impossible")).toThrow(
      "Unknown difficulty"
    );
  });
});

// ── rollCheck (d20 system) ────────────────────────────────────────

describe("rollCheck - d20 system", () => {
  let mathRandomSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    mathRandomSpy?.mockRestore();
  });

  it("returns success when roll >= DC", () => {
    // Mock Math.random to return 0.75 → floor(0.75*20)+1 = 16
    mathRandomSpy = vi.spyOn(Math, "random").mockReturnValue(0.75);
    const result = rollCheck({ difficulty: "easy" }) as CheckResult;

    expect(result.outcome).toBe("success");
    expect(result.dc).toBe(8);
    expect(result.total).toBe(16);
    expect(result.margin).toBe(8);
  });

  it("returns failure when roll < DC", () => {
    // Mock: floor(0.1*20)+1 = 3
    mathRandomSpy = vi.spyOn(Math, "random").mockReturnValue(0.1);
    const result = rollCheck({ difficulty: "hard" }) as CheckResult;

    expect(result.outcome).toBe("failure");
    expect(result.dc).toBe(16);
    expect(result.total).toBe(3);
    expect(result.margin).toBe(-13);
  });

  it("returns critical_success on natural 20", () => {
    // Mock: floor(0.95*20)+1 = 20
    mathRandomSpy = vi.spyOn(Math, "random").mockReturnValue(0.95);
    const result = rollCheck({ difficulty: "legendary" }) as CheckResult;

    expect(result.outcome).toBe("critical_success");
    expect(result.roll.rolls[0]).toBe(20);
  });

  it("returns critical_failure on natural 1", () => {
    // Mock: floor(0.0*20)+1 = 1
    mathRandomSpy = vi.spyOn(Math, "random").mockReturnValue(0.0);
    const result = rollCheck({ difficulty: "easy" }) as CheckResult;

    expect(result.outcome).toBe("critical_failure");
    expect(result.roll.rolls[0]).toBe(1);
  });

  it("applies modifier to total", () => {
    // Mock: floor(0.5*20)+1 = 11
    mathRandomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);
    const result = rollCheck({
      modifier: 3,
      difficulty: "medium",
    }) as CheckResult;

    expect(result.total).toBe(14); // 11 + 3
    expect(result.outcome).toBe("success"); // 14 >= 12
  });

  it("defaults to d20 system and medium difficulty", () => {
    mathRandomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);
    const result = rollCheck({}) as CheckResult;

    expect(result.dc).toBe(12); // medium
    expect(result.roll.expression).toContain("1d20");
  });
});

// ── rollCheck (percentage system) ─────────────────────────────────

describe("rollCheck - percentage system", () => {
  let mathRandomSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    mathRandomSpy?.mockRestore();
  });

  it("returns success when roll <= successRate", () => {
    // Mock: floor(0.3*100)+1 = 31
    mathRandomSpy = vi.spyOn(Math, "random").mockReturnValue(0.3);
    const result = rollCheck({
      system: "percentage",
      successRate: 50,
    }) as PercentageCheckResult;

    expect(result.outcome).toBe("success");
    expect(result.rolled).toBe(31);
    expect(result.successRate).toBe(50);
  });

  it("returns failure when roll > successRate", () => {
    // Mock: floor(0.8*100)+1 = 81
    mathRandomSpy = vi.spyOn(Math, "random").mockReturnValue(0.8);
    const result = rollCheck({
      system: "percentage",
      successRate: 50,
    }) as PercentageCheckResult;

    expect(result.outcome).toBe("failure");
    expect(result.rolled).toBe(81);
  });

  it("clamps successRate to 0-100", () => {
    mathRandomSpy = vi.spyOn(Math, "random").mockReturnValue(0.0);
    const result = rollCheck({
      system: "percentage",
      successRate: 150,
    }) as PercentageCheckResult;

    expect(result.successRate).toBe(100);
  });

  it("defaults successRate to 50", () => {
    mathRandomSpy = vi.spyOn(Math, "random").mockReturnValue(0.0);
    const result = rollCheck({
      system: "percentage",
    }) as PercentageCheckResult;

    expect(result.successRate).toBe(50);
  });
});

// ── rollCheck (custom system) ─────────────────────────────────────

describe("rollCheck - custom system", () => {
  let mathRandomSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    mathRandomSpy?.mockRestore();
  });

  it("rolls custom expression against DC", () => {
    // Mock: for 2d6, two calls → floor(0.5*6)+1 = 4, floor(0.5*6)+1 = 4 → total 8
    mathRandomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);
    const result = rollCheck({
      system: "custom",
      expression: "2d6",
      difficulty: "easy",
    }) as CheckResult;

    expect(result.dc).toBe(8);
    expect(result.roll.rolls).toHaveLength(2);
    expect(result.total).toBe(8); // 4 + 4
    expect(result.outcome).toBe("success"); // 8 >= 8
  });

  it("throws when expression is missing", () => {
    expect(() =>
      rollCheck({ system: "custom", difficulty: "easy" })
    ).toThrow('Custom dice system requires an "expression" parameter');
  });
});

// ── Tool Handlers ─────────────────────────────────────────────────

describe("rollCheckTool", () => {
  let mathRandomSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Mock: floor(0.75*20)+1 = 16
    mathRandomSpy = vi.spyOn(Math, "random").mockReturnValue(0.75);
  });

  afterEach(() => {
    mathRandomSpy.mockRestore();
  });

  function makeCtx(input: unknown): ToolExecutionContext {
    return {
      input,
      runtimeId: "test-runtime",
      pluginId: "core-dice",
      locale: "en-US",
    };
  }

  it("returns check result with proposals", async () => {
    const result = await rollCheckTool(
      makeCtx({ skill: "stealth", difficulty: "medium" })
    );

    expect(result.output).toBeDefined();
    expect(result.proposals).toBeDefined();
    expect(result.proposals!.length).toBe(3);

    const eventProposal = result.proposals![0]!;
    expect(eventProposal.kind).toBe("event.emit");

    const stateProposal = result.proposals![1]!;
    expect(stateProposal.kind).toBe("state.patch");

    const uiProposal = result.proposals![2]!;
    expect(uiProposal.kind).toBe("ui.render");
  });

  it("emits state.patch with skill name", async () => {
    const result = await rollCheckTool(
      makeCtx({ skill: "persuasion", difficulty: "hard" })
    );

    const patch = result.proposals![1]! as {
      kind: string;
      payload: { path: string; value: { skill: string } };
    };
    expect(patch.payload.path).toBe("lastRollResult");
    expect(patch.payload.value.skill).toBe("persuasion");
  });

  it("handles missing input gracefully", async () => {
    const result = await rollCheckTool(makeCtx(undefined));

    expect(result.output).toBeDefined();
    expect(result.proposals).toHaveLength(3);
  });
});

describe("rollDiceTool", () => {
  let mathRandomSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mathRandomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);
  });

  afterEach(() => {
    mathRandomSpy.mockRestore();
  });

  function makeCtx(input: unknown): ToolExecutionContext {
    return {
      input,
      runtimeId: "test-runtime",
      pluginId: "core-dice",
      locale: "en-US",
    };
  }

  it("returns dice roll with event proposal", async () => {
    const result = await rollDiceTool(makeCtx({ expression: "2d6+3" }));

    expect(result.output).toBeDefined();
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals![0]!.kind).toBe("event.emit");
  });

  it("throws when expression is missing", async () => {
    await expect(rollDiceTool(makeCtx({}))).rejects.toThrow(
      'roll-dice requires an "expression" parameter'
    );
  });

  it("throws when input is undefined", async () => {
    await expect(rollDiceTool(makeCtx(undefined))).rejects.toThrow(
      'roll-dice requires an "expression" parameter'
    );
  });
});

// ── Context Provider ──────────────────────────────────────────────

describe("diceContextProvider", () => {
  function makeCtx(
    state: unknown,
    locale = "zh-CN"
  ): ContextProviderInput {
    return {
      pluginId: "core-dice",
      runtimeId: "test-runtime",
      locale,
      state,
    };
  }

  it("returns null when no lastRollResult in state", async () => {
    const result = await diceContextProvider(makeCtx({}));
    expect(result).toBeNull();
  });

  it("returns null when state is undefined", async () => {
    const result = await diceContextProvider(makeCtx(undefined));
    expect(result).toBeNull();
  });

  it("formats d20 result in zh-CN", async () => {
    const state = {
      lastRollResult: {
        skill: "隐匿",
        system: "d20",
        outcome: "success",
        roll: { total: 18, rolls: [15] },
        dc: 12,
        total: 18,
        margin: 6,
      },
    };
    const result = await diceContextProvider(makeCtx(state, "zh-CN"));
    expect(result).toContain("最近判定结果");
    expect(result).toContain("隐匿");
    expect(result).toContain("成功");
    expect(result).toContain("18");
    expect(result).toContain("DC 12");
    expect(result).toContain("+6");
  });

  it("formats d20 result in en-US", async () => {
    const state = {
      lastRollResult: {
        skill: "stealth",
        system: "d20",
        outcome: "critical_failure",
        roll: { total: 1, rolls: [1] },
        dc: 12,
        total: 1,
        margin: -11,
      },
    };
    const result = await diceContextProvider(makeCtx(state, "en-US"));
    expect(result).toContain("Recent Check Result");
    expect(result).toContain("stealth");
    expect(result).toContain("Critical Failure");
    expect(result).toContain("-11");
  });

  it("formats percentage result", async () => {
    const state = {
      lastRollResult: {
        skill: "luck",
        system: "percentage",
        outcome: "success",
        rolled: 30,
        successRate: 50,
      },
    };
    const result = await diceContextProvider(makeCtx(state, "en-US"));
    expect(result).toContain("luck");
    expect(result).toContain("Success");
    expect(result).toContain("30");
    expect(result).toContain("50%");
  });
});
