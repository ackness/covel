import { afterEach, describe, expect, it, vi } from "vitest";
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
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ["zh-CN", "en"],
    ["en-US", "zh"],
    ["ru-RU", "en"],
    ["ru-RU", "zh"],
    ["zh-Hant-TW", "en"],
    ["zh-Hant-TW", "zh"],
  ])(
    "omits an unavailable attribute for %s content with %s instructions",
    async (locale, instructionLocale) => {
      vi.stubEnv("COVEL_INSTRUCTION_LOCALE", instructionLocale);
      const metersOnly = {
        characterSchema: {
          attributes: [
            {
              id: "hp",
              name: "Health",
              type: "number",
              min: 0,
              max: 20,
              category: "stats",
            },
            { id: "luck", name: "Luck", type: "number", category: "abilities" },
          ],
        },
        characters: [
          {
            id: "p1",
            type: "player",
            name: "Ada",
            fields: { hp: 12, luck: 3 },
          },
        ],
      };

      for (const world of [undefined, metersOnly]) {
        const result = await handler(makeCtx({ locale, world }));
        const context = result.value.checkContext;
        if (instructionLocale === "zh") {
          expect(context).toContain("## 本回合判定");
          expect(context).toContain("修正取 0，回执中省略 attribute");
          expect(context).toContain("仅在使用属性时填写 `attribute`");
        } else {
          expect(context).toContain("## Dice checks for this turn");
          expect(context).toContain("Use modifier 0 and omit attribute");
          expect(context).toContain(
            "Include `attribute` only when an attribute is used",
          );
        }
        expect(context).not.toMatch(/"None"|「无」/);
        expect(context).not.toContain("Health 12/20");
        expect(context).not.toContain("Luck 3");
      }
    },
  );

  it.each([
    ["zh-CN", "en", "坚毅"],
    ["en-US", "zh", "Grit"],
    ["ru-RU", "zh", "Стойкость"],
  ])(
    "keeps %s attribute names with %s instructions",
    async (locale, instructionLocale, attributeName) => {
      vi.stubEnv("COVEL_INSTRUCTION_LOCALE", instructionLocale);
      const world = {
        characterSchema: {
          attributes: [
            {
              id: "grit",
              name: { en: "Grit", zh: "坚毅", ru: "Стойкость" },
              type: "number",
              min: 0,
              max: 5,
              category: "abilities",
            },
          ],
        },
        characters: [
          { id: "p1", type: "player", name: "Ada", fields: { grit: 2 } },
        ],
      };

      const result = await handler(makeCtx({ locale, world }));
      expect(result.value.checkContext).toContain(`${attributeName} 2/5 → +4`);
      expect(result.value.checkContext).toContain(
        instructionLocale === "zh"
          ? "2. 从下方修正表选出这个行动用到的属性"
          : "2. Choose the attribute in the modifier list below",
      );
    },
  );

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

  it("lists the player character's check attributes converted from their ranges", async () => {
    const world = {
      characterSchema: {
        attributes: [
          {
            id: "grit",
            name: "坚毅",
            type: "number",
            min: 0,
            max: 5,
            category: "abilities",
          },
          {
            id: "vitality",
            name: "体力",
            type: "number",
            min: 0,
            max: 100,
            category: "stats",
          },
          {
            id: "trust",
            name: "信任",
            type: "number",
            min: 0,
            max: 100,
            category: "social",
          },
          { id: "calling", name: "使命", type: "string", category: "bio" },
        ],
      },
      characters: [
        {
          id: "p1",
          type: "player",
          name: "亚瑟",
          fields: { grit: 2, vitality: 80, trust: 40, calling: "scholar" },
        },
      ],
    };
    const result = await handler(makeCtx({ locale: "zh-CN", world }));

    expect(result.value.checkContext).toContain("坚毅 2/5 → +4");
    // Meters and relationships are not check attributes.
    expect(result.value.checkContext).not.toContain("体力 80/100");
    expect(result.value.checkContext).not.toContain("信任 40/100");
    expect(result.value.checkContext).not.toContain("使命");
  });

  it("excludes meters and unbounded abilities from the modifier list", async () => {
    const world = {
      characterSchema: {
        attributes: [
          {
            id: "hp",
            name: "Health",
            type: "number",
            min: 0,
            max: 20,
            category: "stats",
          },
          { id: "luck", name: "Luck", type: "number", category: "abilities" },
        ],
      },
      characters: [
        { id: "p1", type: "player", name: "Ada", fields: { hp: 12, luck: 3 } },
      ],
    };
    const result = await handler(makeCtx({ locale: "en-US", world }));

    expect(result.value.checkContext).not.toContain("Health 12/20");
    expect(result.value.checkContext).not.toContain("Luck 3");
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
