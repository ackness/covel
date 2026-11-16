import { judgeCheck } from "../lib/check-plan.js";
import {
  isDifficulty,
  isModifier,
  OUTCOMES,
  rollText,
} from "../lib/check-rules.js";
import { acceptReceipt, poolOf } from "../lib/turn-pool.js";

const TOPIC = "check.resolved";

/**
 * Check a `check.resolved` receipt against this turn's dice at the moment the
 * narrative sends it. A receipt whose outcome is not the one the dice give is
 * sent back with the correct outcomes, so the narrative can send it again and
 * then write prose that matches. Without this the mismatch is found by the
 * recorder after the turn is written, when nothing can be corrected.
 *
 * It only guards. The dice are the roller's, the rules are in
 * `lib/check-rules.js`, and the recorder remains the one that writes.
 */
export default function verifyCheckReceipt(ctx, payload) {
  if (payload.toolCall.name !== "emit-event") return { action: "continue" };
  let args;
  try {
    args = JSON.parse(payload.toolCall.arguments);
  } catch {
    return { action: "continue" };
  }
  if (args?.topic !== TOPIC) return { action: "continue" };
  const checks = args.data?.checks;
  const pool = poolOf(ctx.sessionId, ctx.turnId);
  // No dice in this process, or a payload the event schema will reject with
  // its own message: let it through.
  if (!pool || !Array.isArray(checks) || checks.length === 0)
    return { action: "continue" };
  const { dice, checkPlan } = pool;
  if (
    checks.some(
      (check) =>
        !check ||
        typeof check !== "object" ||
        !isModifier(check.modifier) ||
        !isDifficulty(check.difficulty) ||
        !OUTCOMES.includes(check.outcome),
    )
  )
    return { action: "continue" };

  if (checks.length > dice.length)
    return {
      action: "abort",
      reason: `check.resolved was not sent: this turn has ${dice.length} checks and the event reports ${checks.length}. Report at most ${dice.length} checks, in order, and send the event again.`,
    };

  const judged = checks.map((check, index) =>
    judgeCheck(dice[index], check, checkPlan),
  );
  const wrong = judged.flatMap(({ result }, index) =>
    result.outcome === checks[index].outcome &&
    result.modifier === checks[index].modifier
      ? []
      : [index],
  );
  // Not marked as accepted here: the event catalogue can still refuse the
  // payload, and the receipt sent after that must be checked as well.
  if (wrong.length === 0) return { action: "continue" };

  const problem = (index) => {
    const { result } = judged[index];
    const check = checks[index];
    return result.modifier !== check.modifier
      ? `check ${index + 1} reports modifier ${check.modifier} and the modifier list gives ${result.modifier} for ${check.attribute}`
      : `check ${index + 1} reports "${check.outcome}" and the dice give "${result.outcome}"`;
  };
  const line = (index) => {
    const { result, chosen, reasons } = judged[index];
    const harder = chosen
      ? ` (${chosen} made ${result.difficulty} by ${reasons.map((reason) => reason.text).join(", ")})`
      : "";
    return `check ${index + 1} (${result.difficulty}${harder}): d20 ${rollText(result)} -> ${result.outcome}`;
  };
  return {
    action: "abort",
    reason: [
      `check.resolved was not sent: ${wrong.map(problem).join("; ")}.`,
      `The results of this turn are: ${judged.map((_, index) => line(index)).join("; ")}.`,
      "Send check.resolved again with these modifiers and outcomes and the same actions, difficulties and people. Then write the prose to match these outcomes.",
    ].join(" "),
  };
}

/**
 * Mark the turn's receipt as accepted when `emit-event` recorded it. A receipt
 * that agreed with the dice but was refused by the event catalogue (a missing
 * field, for example) is not recorded, so the one sent after it is checked
 * against the dice again.
 */
export function acceptRecordedReceipt(ctx, payload) {
  if (payload.toolCall.name !== "emit-event") return { action: "continue" };
  if (payload.result?.success !== true) return { action: "continue" };
  let args;
  try {
    args = JSON.parse(payload.toolCall.arguments);
  } catch {
    return { action: "continue" };
  }
  // The review hook reads the receipt to find the costs of failed checks.
  if (args?.topic === TOPIC && Array.isArray(args.data?.checks))
    acceptReceipt(ctx.sessionId, ctx.turnId, {
      runtimeId: ctx.runtimeId,
      checks: args.data.checks,
    });
  return { action: "continue" };
}
