import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { parseDiceNotation, rollDice } from "../rpc/dice.js";
import roll from "../rpc/roll.js";
import registerDiceCheck from "../server/index.js";

describe("dice-check roll command", () => {
  it("binds JSON-render quick-roll buttons to the canonical roll command", async () => {
    const panel = JSON.parse(
      await readFile(
        new URL("../runtimes/recorder/ui/checks-panel.json", import.meta.url),
        "utf8",
      ),
    );
    const quickRollCard = panel.view.children[0];
    const buttons = quickRollCard.children[1].children;

    expect(panel.alwaysRender).toBe(true);
    expect(buttons.map((button) => button.on.click)).toEqual([
      {
        action: "invokeCommand",
        params: { command: "roll", args: { notation: "1d20" } },
      },
      {
        action: "invokeCommand",
        params: { command: "roll", args: { notation: "2d6" } },
      },
    ]);
  });

  it("registers the roll RPC from the package entry", () => {
    const registerRpc = vi.fn();
    registerDiceCheck({ registerRpc });

    expect(registerRpc).toHaveBeenCalledWith(
      "roll",
      roll,
      expect.objectContaining({ description: expect.any(String) }),
    );
  });

  it("parses the default and bounded NdM notation", () => {
    expect(parseDiceNotation(undefined)).toMatchObject({
      ok: true,
      notation: "1d20",
      count: 1,
      sides: 20,
    });
    expect(parseDiceNotation(" 2D6 ")).toMatchObject({
      ok: true,
      notation: "2d6",
      count: 2,
      sides: 6,
    });
    expect(parseDiceNotation("101d6")).toEqual({
      ok: false,
      code: "invalid-count",
    });
    expect(parseDiceNotation("1d1001")).toEqual({
      ok: false,
      code: "invalid-sides",
    });
    expect(parseDiceNotation("coin")).toEqual({
      ok: false,
      code: "invalid-notation",
    });
  });

  it("uses the injected half-open RNG and totals every die", () => {
    const randomInteger = vi.fn(() => 4);
    const result = rollDice(
      { notation: "3d6", count: 3, sides: 6 },
      randomInteger,
    );

    expect(result).toEqual({ notation: "3d6", rolls: [4, 4, 4], total: 12 });
    expect(randomInteger).toHaveBeenCalledTimes(3);
    expect(randomInteger).toHaveBeenCalledWith(1, 7);
  });

  it("reads notation from command args and returns a host-safe result", async () => {
    const setPluginData = vi.fn();
    const result = await roll(
      {
        command: "roll",
        raw: "/roll 4d8",
        argv: ["4d8"],
        args: { notation: "4d8" },
      },
      { locale: "en-US", store: { setPluginData } },
    );

    expect(result.ok).toBe(true);
    expect(result.message).toContain("4d8");
    expect(result.data.notation).toBe("4d8");
    expect(result.data.rolls).toHaveLength(4);
    expect(result.data.total).toBe(
      result.data.rolls.reduce((sum, value) => sum + value, 0),
    );
    for (const value of result.data.rolls) {
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(8);
    }
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(setPluginData).not.toHaveBeenCalled();
  });

  it("localizes validation errors from the session locale", async () => {
    const zh = await roll({ args: { notation: "0d6" } }, { locale: "zh-CN" });
    const en = await roll(
      { args: { notation: "2d1001" } },
      { locale: "en-US" },
    );

    expect(zh).toMatchObject({ ok: false, data: { code: "invalid-count" } });
    expect(zh.message).toContain("骰子数量");
    expect(en).toMatchObject({ ok: false, data: { code: "invalid-sides" } });
    expect(en.message).toContain("Die sides");
  });

  it("uses English fallback for non-default and Traditional Chinese locales", async () => {
    for (const locale of ["ru-RU", "ja-JP", "zh-Hant-TW", "zh-TW"]) {
      const result = await roll({ args: { notation: "bad" } }, { locale });
      expect(result.message).toContain("Use NdM dice notation");
      expect(result.message).not.toContain("请使用");
    }

    const simplified = await roll(
      { args: { notation: "bad" } },
      { locale: "zh-Hans" },
    );
    expect(simplified.message).toContain("请使用");
  });
});
