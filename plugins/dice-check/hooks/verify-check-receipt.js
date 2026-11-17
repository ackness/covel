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
  const pool = poolOf(ctx.sessionId, ctx.turnId, ctx.runtimeId);
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
  const invalidAttributes = judged.flatMap(({ problem }, index) =>
    problem ? [`check ${index + 1}: ${problem}`] : [],
  );
  if (invalidAttributes.length > 0)
    return {
      action: "abort",
      reason: `check.resolved was not sent: ${invalidAttributes.join("; ")}. Use the matching modifiers and outcomes and send the corrected batch before writing the prose.`,
    };
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
      ? check.attribute === undefined
        ? `check ${index + 1} reports modifier ${check.modifier} but must use 0 without an attribute`
        : `check ${index + 1} reports modifier ${check.modifier} and the modifier list gives ${result.modifier} for ${check.attribute}`
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

/** The checks of the first receipt in a list of events, or undefined. */
function firstReceipt(events) {
  if (!Array.isArray(events)) return undefined;
  const event = events.find(
    (candidate) => candidate && candidate.topic === TOPIC,
  );
  return Array.isArray(event?.data?.checks) ? event.data.checks : undefined;
}

/**
 * Remember the receipts a tool of the runtime recorded, by the channel the
 * kernel delivers them through: an event in the tool's result, or an event
 * the tool emitted (`emit-event`, or a plugin tool's emitted events). A
 * receipt that the event catalogue refused, or a repeat that `emit-event`
 * answered without recording it, emits nothing, so the receipt sent after it
 * is checked against the dice again.
 */
export function acceptRecordedReceipt(ctx, payload) {
  const result = payload.result;
  if (result?.success !== true) return { action: "continue" };
  for (const [channel, events] of [
    ["result", result.parsedResult?.events],
    ["emitted", result.emittedEvents],
  ]) {
    const checks = firstReceipt(events);
    if (checks)
      acceptReceipt(ctx.sessionId, ctx.turnId, channel, {
        runtimeId: ctx.runtimeId,
        checks,
      });
  }
  return { action: "continue" };
}
