import { pickLocaleText } from "@covel/plugin-handlers-utils";
import { judgeCheck } from "../lib/check-plan.js";
import { isDifficulty, isModifier } from "../lib/check-rules.js";
import { newLedger, resolveCost } from "../lib/consequences.js";
import { markReviewed, reviewOf } from "../lib/turn-pool.js";

/**
 * Whether the prose uses a cue. A cue in a script with spaces between words
 * must begin a word, so "mark" is found in "marked" but not in "remark"; a
 * cue in Chinese or Japanese is found anywhere.
 *
 * @param {string} prose Lower-case prose.
 * @param {string} cue
 */
function mentions(prose, cue) {
  const wanted = cue.toLowerCase();
  if (
    !/^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\d\s'-]+$/u.test(
      wanted,
    )
  )
    return prose.includes(wanted);
  const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}`, "u").test(prose);
}

/** The prose of a submitted story: its segments, or its narrative text. */
function proseOf(output) {
  if (Array.isArray(output?.segments))
    return output.segments
      .map((segment) => (typeof segment?.text === "string" ? segment.text : ""))
      .join("\n");
  return typeof output?.narrativeOutput === "string"
    ? output.narrativeOutput
    : "";
}

/**
 * Send the story back once when it skips the cost of a failed check.
 *
 * The recorder pays the cost whatever the prose says, so the state is right
 * either way; this hook keeps the prose in step with it. A world gives each
 * cost a few `cues`, words that prose showing the cost would use ("cold",
 * "soaked"). When the runtime that sent this turn's `check.resolved` submits
 * a story that uses none of the cues of a failed check's cost, the story is
 * sent back one time with the cost to write. A cost without cues is never
 * checked, and the second submission is accepted as it is.
 */
export default function reviewCostProse(ctx, payload) {
  const review = reviewOf(ctx.sessionId, ctx.turnId, ctx.runtimeId);
  if (!review) return { action: "continue" };
  // Another reviewer already sends this story back; the first correction is
  // the one the model gets, so this one waits for the next submission.
  if (payload.correction) return { action: "continue" };
  const prose = proseOf(payload.output).toLowerCase();
  const ledger = newLedger();
  const missing = [];
  review.receipt.checks.forEach((check, index) => {
    // Only the checks the recorder records pay a cost: those that agree
    // with the turn's dice and plan.
    const roll = review.dice[index];
    if (
      roll === undefined ||
      !check ||
      typeof check !== "object" ||
      !isModifier(check.modifier) ||
      !isDifficulty(check.difficulty)
    )
      return;
    const { result } = judgeCheck(roll, check, review.checkPlan);
    if (result?.modifier !== check.modifier || result.outcome !== check.outcome)
      return;
    const entry = resolveCost(review.plan, check, ledger);
    if (!entry || entry.cues.length === 0) return;
    if (!entry.cues.some((cue) => mentions(prose, cue)))
      missing.push({ index, check, entry });
  });
  if (missing.length === 0) return { action: "continue" };
  markReviewed(ctx.sessionId, ctx.turnId, ctx.runtimeId);
  const lines = missing.map(({ index, check, entry }) =>
    pickLocaleText(
      ctx.locale,
      `判定 ${index + 1}（${check.action ?? ""}）失败了，它的代价是：${entry.text}`,
      `Check ${index + 1} (${check.action ?? ""}) failed, and its cost is: ${entry.text}`,
    ),
  );
  return {
    action: "continue",
    replace: {
      correction: [
        pickLocaleText(
          ctx.locale,
          "正文没有写出失败检定的代价。系统已经结算了这个代价，玩家会看到它。",
          "The story does not show the cost of a failed check. The system has applied the cost, and the player will see it.",
        ),
        ...lines,
        pickLocaleText(
          ctx.locale,
          "改写正文，让这个代价在场景里发生，然后重新提交。",
          "Rewrite the story so that this cost happens in the scene, then submit it again.",
        ),
      ]
        .join("\n")
        .slice(0, 2000),
    },
  };
}
