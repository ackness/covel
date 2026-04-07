import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tool as rollLuck } from "../../tools/roll-luck.js";

describe("roll-luck tool", () => {
  it("returns a bounded weighted roll", async () => {
    const result = await rollLuck.execute({
      input: {
        modifier: 5,
        weight: 1
      }
    });

    assert.ok(result.roll >= 1 && result.roll <= 100);
    assert.ok(result.weightedRoll >= 1 && result.weightedRoll <= 100);
  });

  it("returns a valid tier", async () => {
    const result = await rollLuck.execute({
      input: {
        modifier: 0,
        weight: 1
      }
    });

    assert.ok(["common", "rare", "epic"].includes(result.tier));
  });
});
