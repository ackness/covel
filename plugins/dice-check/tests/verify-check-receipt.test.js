import { beforeEach, describe, expect, it } from "vitest";
import verifyCheckReceipt from "../hooks/verify-check-receipt.js";
import { forgetPool, rememberPool } from "../lib/turn-pool.js";

const ctx = { sessionId: "sess-1", turnId: "turn-7" };

function emit(checks, topic = "check.resolved") {
  return {
    toolCall: {
      id: "call-1",
      name: "emit-event",
      arguments: JSON.stringify({ topic, data: { checks } }),
    },
    pluginId: "narrator",
    runtimeId: "narrator",
  };
}

const check = (patch = {}) => ({
  action: "Force the relay hatch",
  attribute: "strength",
  modifier: 2,
  difficulty: "normal",
  outcome: "failure",
  ...patch,
});

/**
 * The narrative sends its check receipt before it writes the prose. The guard
 * compares the receipt with the turn's dice at that moment, so that a wrong
 * outcome is corrected while the turn can still be written to match.
 */
describe("dice-check receipt guard", () => {
  beforeEach(() => {
    // Check 1 is a 7, check 2 a natural 20, check 3 a natural 1.
    rememberPool(ctx.sessionId, ctx.turnId, [7, 20, 1]);
  });

  it("lets a receipt through when every outcome is the one the dice give", () => {
    expect(
      verifyCheckReceipt(
        ctx,
        emit([
          check(), // 7 + 2 = 9 against DC 12
          check({ outcome: "critical-success" }),
          check({ difficulty: "easy", outcome: "critical-failure" }),
        ]),
      ),
    ).toEqual({ action: "continue" });
  });

  it("checks one receipt in a turn: a repeat after it is left to emit-event", () => {
    expect(verifyCheckReceipt(ctx, emit([check()]))).toEqual({
      action: "continue",
    });
    // emit-event records one event of a topic in a turn and answers a repeat
    // itself. Sending the repeat back would only cost another round.
    expect(
      verifyCheckReceipt(ctx, emit([check({ outcome: "success" })])),
    ).toEqual({ action: "continue" });
  });

  it("sends back a receipt that reports a success the die did not give", () => {
    const result = verifyCheckReceipt(
      ctx,
      emit([check({ outcome: "success" })]),
    );

    expect(result.action).toBe("abort");
    // The message gives what to send instead, with the arithmetic.
    expect(result.reason).toContain(
      'check 1 reports "success" and the dice give "failure"',
    );
    expect(result.reason).toContain(
      "check 1 (normal): d20 7 + 2 = 9 vs DC 12 -> failure",
    );
    expect(result.reason).toContain("Send check.resolved again");
  });

  it("does not let a second check take the die of the first", () => {
    // The narrative skipped the 7 and wrote the natural 20 for its only check.
    const result = verifyCheckReceipt(
      ctx,
      emit([check({ outcome: "critical-success" })]),
    );
    expect(result.action).toBe("abort");
    expect(result.reason).toContain("-> failure");
  });

  it("sends back a receipt with more checks than the turn has dice", () => {
    const result = verifyCheckReceipt(
      ctx,
      emit([check(), check(), check(), check()]),
    );
    expect(result.action).toBe("abort");
    expect(result.reason).toContain("this turn has 3 checks");
  });

  it("leaves a malformed receipt to the event schema", () => {
    for (const item of [
      check({ modifier: "2" }),
      check({ difficulty: "legendary" }),
      check({ outcome: "maybe" }),
      null,
    ])
      expect(verifyCheckReceipt(ctx, emit([item]))).toEqual({
        action: "continue",
      });
  });

  it("does not touch other tools, other topics, or a turn it has no dice for", () => {
    expect(
      verifyCheckReceipt(ctx, {
        toolCall: { id: "c", name: "get-character", arguments: "{}" },
      }),
    ).toEqual({ action: "continue" });
    expect(
      verifyCheckReceipt(
        ctx,
        emit([check({ outcome: "success" })], "quest.updated"),
      ),
    ).toEqual({ action: "continue" });

    // Without the dice the recorder is the one that checks.
    forgetPool(ctx.sessionId, ctx.turnId);
    expect(
      verifyCheckReceipt(ctx, emit([check({ outcome: "success" })])),
    ).toEqual({ action: "continue" });
  });
});
