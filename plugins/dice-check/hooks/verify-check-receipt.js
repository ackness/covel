import {
  isDifficulty,
  isModifier,
  OUTCOMES,
  resolveCheck,
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
  const dice = poolOf(ctx.sessionId, ctx.turnId);
  // No dice in this process, or a payload the event schema will reject with
  // its own message: let it through.
  if (!dice || !Array.isArray(checks) || checks.length === 0)
    return { action: "continue" };
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

  const results = checks.map((check, index) =>
    resolveCheck(dice[index], check.modifier, check.difficulty),
  );
  const wrong = results.flatMap((result, index) =>
    result.outcome === checks[index].outcome ? [] : [index],
  );
  if (wrong.length === 0) {
    acceptReceipt(ctx.sessionId, ctx.turnId);
    return { action: "continue" };
  }

  const line = (index) => {
    const result = results[index];
    return `check ${index + 1} (${result.difficulty}): d20 ${rollText(result)} -> ${result.outcome}`;
  };
  return {
    action: "abort",
    reason: [
      `check.resolved was not sent: ${wrong
        .map(
          (index) =>
            `check ${index + 1} reports "${checks[index].outcome}" and the dice give "${results[index].outcome}"`,
        )
        .join("; ")}.`,
      `The outcomes of this turn are: ${results.map((_, index) => line(index)).join("; ")}.`,
      "Send check.resolved again with these outcomes and the same actions, modifiers and difficulties. Then write the prose to match these outcomes.",
    ].join(" "),
  };
}
