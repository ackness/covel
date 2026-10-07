import { describe, expect, it } from "vitest";
import { estimateTokens } from "@covel/shared";
import { WORLD_LORE_TOKEN_BUDGET, fitWorldLore } from "../src/world-lore.js";

describe("fitWorldLore", () => {
  it("carries lore under the budget as it is, in either language", () => {
    for (const lore of [
      "雾港的潮钟每日三鸣。\n".repeat(600),
      "The tide bell of Mistport rings three times a day.\n".repeat(450),
    ]) {
      expect(estimateTokens(lore)).toBeLessThan(WORLD_LORE_TOKEN_BUDGET);
      expect(fitWorldLore(lore)).toMatchObject({
        text: lore,
        truncated: false,
      });
    }
  });

  it("cuts longer lore after a whole line and marks the cut", () => {
    const line = "The tide bell of Mistport rings three times a day.";
    const fitted = fitWorldLore(`${line}\n`.repeat(2000));
    expect(fitted.truncated).toBe(true);
    expect(fitted.tokens).toBeGreaterThan(WORLD_LORE_TOKEN_BUDGET);
    const lines = fitted.text.split("\n");
    expect(lines.at(-1)).toBe("…");
    expect(lines.slice(0, -1).every((kept) => kept === line)).toBe(true);
    expect(estimateTokens(fitted.text)).toBeLessThanOrEqual(
      WORLD_LORE_TOKEN_BUDGET,
    );
    // Most of the budget is used: the cut is not far before the limit.
    expect(estimateTokens(fitted.text)).toBeGreaterThan(
      WORLD_LORE_TOKEN_BUDGET * 0.95,
    );
  });
});
