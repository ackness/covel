import { labelText } from "@covel/plugin-handlers-utils";
import {
  isDifficulty,
  isModifier,
  resolveCheck,
  rollText,
} from "../../lib/check-rules.js";

/**
 * @typedef {import("@covel/plugin-handlers-utils").PluginFunctionContext & { execution?: { sourceTurnId?: string } }} RecorderContext
 */

const CHECKS_NAMESPACE = "checks";
const MESSAGE_NAMESPACE = "message";

// Presentation is computed here so the json-render specs stay dumb: they just
// bind label/color/critical fields off the stored record.
const OUTCOME_PRESENTATION = {
  success: {
    color: "green",
    critical: false,
  },
  failure: {
    color: "red",
    critical: false,
  },
  "critical-success": {
    color: "purple",
    critical: true,
  },
  "critical-failure": {
    color: "amber",
    critical: true,
  },
};

/**
 * The outcome's name in every language the plugin ships. Only the panel and
 * the message block draw it; they pick the player's UI language.
 */
function outcomeLabel(ctx, outcome) {
  // Each text is a literal: the validator reads them from the source.
  const labels = {
    success: labelText(ctx, "Success"),
    failure: labelText(ctx, "Failure"),
    "critical-success": labelText(ctx, "Critical success"),
    "critical-failure": labelText(ctx, "Critical failure"),
  };
  return labels[outcome];
}

/**
 * Record the `check.resolved` receipt batch emitted by the narrative engine.
 * The payload carries ALL checks of the turn in one `checks` array because
 * emit-event dedupes by topic per turn — a second emission would be dropped.
 * A receipt holds what the narrative decided: the action, the attribute, the
 * modifier, the difficulty, and the outcome it wrote. The die is not in it:
 * this handler takes the turn's dice in order, calculates the DC, the total
 * and the outcome by the rules, and records a check only when the outcome
 * the narrative wrote is the one the dice give.
 *
 * @param {RecorderContext} ctx
 */
export default async function handler(ctx) {
  if (!ctx.triggerEvent) {
    return { outcome: "skipped", skipReason: "No check event to record" };
  }
  // A settled tabletop form owns checks in its source turn. Its independent
  // die must never be reinterpreted as one from this plugin's pre-rolled pool.
  const sourceTurnId = ctx.execution?.sourceTurnId ?? ctx.turnId;
  if (ctx.inputs?.tabletopCheck?.value?.resolvedTurnId === sourceTurnId) {
    return {
      outcome: "skipped",
      skipReason: "The tabletop check already settled this turn",
    };
  }
  const data = ctx.triggerEvent?.data;
  // Tolerate a bare single-check payload (schema forbids it, but a hand-made
  // event should degrade to "one check" rather than a skip).
  const rawChecks =
    data && typeof data === "object" && Array.isArray(data.checks)
      ? data.checks
      : [data];
  const previousChecks = await readTurnChecks(ctx);
  const dice = await readDicePool(ctx);
  const records = [];
  let skipped = 0;
  for (const raw of rawChecks) {
    const expectedRoll = dice[previousChecks.length + records.length + skipped];
    if (expectedRoll === undefined) break;
    const record = parseCheck(raw, expectedRoll);
    // A die is used by its check even when the receipt is wrong, so that
    // the checks after it keep their own dice.
    if (record === null) skipped += 1;
    else records.push(record);
  }
  if (records.length === 0) {
    return {
      outcome: "failed",
      error:
        "The reported check could not be verified against this turn's dice and rules. No check was recorded. The outcome must be the one that the turn's dice give for the reported modifier and difficulty.",
    };
  }

  // The turn's block already lists every earlier check, one per sequence number.
  const firstSeq = previousChecks.length + 1;
  const entries = records.map((record, index) => {
    const presentation = OUTCOME_PRESENTATION[record.outcome];
    return {
      ...record,
      turnId: ctx.turnId,
      seq: firstSeq + index,
      outcomeLabel: outcomeLabel(ctx, record.outcome),
      outcomeColor: presentation.color,
      critical: presentation.critical,
      rollText: rollText(record),
    };
  });
  return {
    outcome: "success",
    effects: {
      pluginData: [
        ...entries.map((entry) => ({
          namespace: CHECKS_NAMESPACE,
          key: `${ctx.turnId}-${entry.seq}`,
          value: entry,
        })),
        {
          // Message-slot data source: `__turnId` binds the block to this
          // turn's message; `checks` is the array the block iterates.
          namespace: MESSAGE_NAMESPACE,
          key: ctx.turnId,
          value: {
            __turnId: ctx.turnId,
            turnId: ctx.turnId,
            checks: [...previousChecks, ...entries],
            rejectedCount: rawChecks.length - records.length,
          },
        },
      ],
    },
  };
}

/**
 * The record of one reported check, or null when the receipt is malformed or
 * its outcome is not the one that this check's die gives.
 *
 * @param {unknown} data
 * @param {number} roll The die of this check, from the pre-rolled pool.
 */
function parseCheck(data, roll) {
  if (!data || typeof data !== "object") return null;
  const payload = /** @type {Record<string, unknown>} */ (data);

  const action =
    typeof payload.action === "string" ? payload.action.trim() : "";
  if (
    !action ||
    !isModifier(payload.modifier) ||
    !isDifficulty(payload.difficulty)
  )
    return null;
  const result = resolveCheck(roll, payload.modifier, payload.difficulty);
  if (payload.outcome !== result.outcome) return null;

  const record = { action, ...result };
  if (typeof payload.attribute === "string" && payload.attribute.trim()) {
    record.attribute = payload.attribute.trim();
  }
  return record;
}

/**
 * Previously recorded checks for this turn's message block, so a second
 * receipt in the same turn appends instead of overwriting.
 *
 * @param {RecorderContext} ctx
 * @returns {Promise<ReadonlyArray<unknown>>}
 */
async function readTurnChecks(ctx) {
  if (!ctx.pluginData?.get) return [];
  const row = await ctx.pluginData.get(MESSAGE_NAMESPACE, ctx.turnId);
  // Tolerate both host shapes: the stored value directly, or a { value } wrapper.
  const value =
    row && typeof row === "object" && "checks" in row ? row : row?.value;
  return Array.isArray(value?.checks) ? value.checks : [];
}

/**
 * Read the immutable pool pre-rolled by dice-check/roller for this turn.
 * Missing or malformed audit data fails closed: a receipt cannot prove which
 * die it consumed without the original pool.
 *
 * @param {RecorderContext} ctx
 * @returns {Promise<ReadonlyArray<number>>}
 */
async function readDicePool(ctx) {
  const inputDice = ctx.inputs?.dicePool?.value;
  if (Array.isArray(inputDice)) return validDice(inputDice);
  if (!ctx.pluginData?.get) return [];
  const row = await ctx.pluginData.get("rolls", ctx.turnId);
  const value =
    row && typeof row === "object" && "dice" in row ? row : row?.value;
  return Array.isArray(value?.dice) ? validDice(value.dice) : [];
}

/** @param {ReadonlyArray<unknown>} dice */
function validDice(dice) {
  return dice.every((die) => Number.isInteger(die) && die >= 1 && die <= 20)
    ? dice
    : [];
}
