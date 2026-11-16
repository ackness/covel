import { labelText } from "@covel/plugin-handlers-utils";
import { attributeLabel } from "../../lib/attributes.js";
import { itemText, judgeCheck } from "../../lib/check-plan.js";
import {
  DIFFICULTY_DCS,
  isDifficulty,
  isModifier,
  rollText,
} from "../../lib/check-rules.js";
import {
  costDetail,
  newLedger,
  PROGRESS_NAMESPACE,
  progressRecord,
  refuse,
  resolveCost,
} from "../../lib/consequences.js";

/**
 * @typedef {import("@covel/plugin-handlers-utils").PluginFunctionContext} RecorderContext
 */

const CHECKS_NAMESPACE = "checks";
const MESSAGE_NAMESPACE = "message";
const CHANGE_CONTRACT = "inventory.change@1";

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
 * "Turn N" in every language the plugin ships, for the check log. The log
 * names a turn by its number; the turn's row ID stays in `turnId` for code.
 *
 * @param {RecorderContext} ctx
 * @param {number} turn
 */
function turnLabel(ctx, turn) {
  const label = labelText(ctx, "Turn {turn}");
  const fill = (text) => text.replaceAll("{turn}", String(turn));
  return typeof label === "string"
    ? fill(label)
    : Object.fromEntries(
        Object.entries(label).map(([language, text]) => [language, fill(text)]),
      );
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
  const rawChecks = Array.isArray(data?.checks) ? data.checks : [];
  if (rawChecks.length === 0) {
    return { outcome: "skipped", skipReason: "No checks array to record" };
  }
  const previousChecks = await readTurnChecks(ctx);
  const dice = await readDicePool(ctx);
  const checkPlan = ctx.inputs?.checkPlan?.value ?? null;
  const records = [];
  let skipped = 0;
  for (const raw of rawChecks) {
    const expectedRoll = dice[previousChecks.length + records.length + skipped];
    if (expectedRoll === undefined) break;
    const record = parseCheck(raw, expectedRoll, checkPlan);
    // A die is used by its check even when the receipt is wrong, so that
    // the checks after it keep their own dice.
    if (record === null) skipped += 1;
    else records.push(record);
  }
  if (records.length === 0) {
    return {
      outcome: "failed",
      error:
        "The reported check could not be verified against this turn's dice and rules. No check was recorded. The modifier must be the one in the turn's modifier list, and the outcome must be the one that the turn's dice give for it at the difficulty after the turn's harder checks.",
    };
  }

  // The turn's block already lists every earlier check, one per sequence number.
  const firstSeq = previousChecks.length + 1;
  const turn = Number.isInteger(ctx.logicalTurn) ? ctx.logicalTurn : undefined;
  const { costs, clockWrites } = await payCosts(
    ctx,
    ctx.inputs?.costPlan?.value,
    records,
    turn,
  );
  const entries = records.map((record, index) => {
    const presentation = OUTCOME_PRESENTATION[record.outcome];
    return {
      ...record,
      ...costs[index],
      ...(record.attribute
        ? {
            attributeLabel: attributeLabel(
              ctx.world,
              record.attribute,
              ctx.locale,
            ),
          }
        : {}),
      turnId: ctx.turnId,
      ...(turn === undefined ? {} : { turn, turnLabel: turnLabel(ctx, turn) }),
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
        ...clockWrites,
      ],
    },
  };
}

/**
 * Pay the cost of each failed check from the turn's cost plan (see
 * `lib/consequences.js`): fill a clock of this plugin, or take an item away
 * through `inventory.change@1`. The roller told the narrative these costs,
 * and they are paid whatever the prose says. An item that cannot be taken
 * (no inventory, or it was already given away this turn) passes the check
 * on to its next cost in the plan.
 *
 * @param {RecorderContext} ctx
 * @param {any} plan
 * @param {ReadonlyArray<{ attribute?: string, outcome: string }>} records
 * @param {number | undefined} turn
 */
async function payCosts(ctx, plan, records, turn) {
  /** @type {Array<Record<string, unknown>>} */
  const costs = records.map(() => ({}));
  const clocks = new Map();
  if (!plan || !Array.isArray(plan.entries)) return { costs, clockWrites: [] };
  const ledger = newLedger();
  for (const [index, record] of records.entries()) {
    for (;;) {
      const entry = resolveCost(plan, record, ledger);
      if (!entry) break;
      const cost = {
        costText: entry.text,
        costDetail: costDetail(plan, entry),
      };
      if (entry.cost.kind === "item") {
        if (await takeItem(ctx, entry.cost)) {
          costs[index] = cost;
          break;
        }
        refuse(ledger, entry);
        continue;
      }
      const clock = plan.clocks[entry.cost.clock];
      const current =
        clocks.get(clock.id) ??
        (await ctx.pluginData?.get?.(PROGRESS_NAMESPACE, clock.id)) ??
        progressRecord(clock, clock.filled);
      const filled = Math.min(
        clock.segments,
        current.filled + entry.cost.ticks,
      );
      const fills = filled >= clock.segments && current.isFull !== true;
      const next = progressRecord(
        clock,
        filled,
        fills ? turn : current.fullTurn,
      );
      clocks.set(clock.id, next);
      costs[index] = {
        ...cost,
        costDetail: `${cost.costDetail} (${next.progressText})`,
        ...(fills && clock.full ? { clockFull: clock.full } : {}),
      };
      break;
    }
  }
  return {
    costs,
    clockWrites: [...clocks.values()].map((value) => ({
      namespace: PROGRESS_NAMESPACE,
      key: value.id,
      value,
    })),
  };
}

/**
 * Take an item from the player character; false when it cannot be taken.
 *
 * @param {RecorderContext} ctx
 * @param {{ item: string, quantity: number }} cost
 */
async function takeItem(ctx, cost) {
  if (!ctx.services) return false;
  try {
    await ctx.services.call(
      {
        contract: CHANGE_CONTRACT,
        input: {
          changes: [{ op: "remove", item: cost.item, quantity: cost.quantity }],
        },
      },
      { signal: ctx.signal },
    );
    return true;
  } catch {
    ctx.signal?.throwIfAborted();
    return false;
  }
}

/**
 * The record of one reported check, or null when the receipt is malformed,
 * its modifier is not the one the turn's modifier list gives, or its outcome
 * is not the one that this check's die gives at the difficulty the turn's
 * harder checks make it.
 *
 * @param {unknown} data
 * @param {number} roll The die of this check, from the pre-rolled pool.
 * @param {any} checkPlan The roller's check plan, or null.
 */
function parseCheck(data, roll, checkPlan) {
  if (!data || typeof data !== "object") return null;
  const payload = /** @type {Record<string, any>} */ (data);

  const action =
    typeof payload.action === "string" ? payload.action.trim() : "";
  if (
    !action ||
    !isModifier(payload.modifier) ||
    !isDifficulty(payload.difficulty)
  )
    return null;
  const { result, item, chosen, reasons } = judgeCheck(
    roll,
    payload,
    checkPlan,
  );
  if (payload.modifier !== result.modifier) return null;
  if (payload.outcome !== result.outcome) return null;

  const record = { action, ...result };
  if (typeof payload.attribute === "string" && payload.attribute.trim()) {
    record.attribute = payload.attribute.trim();
  }
  // What the player sees besides the die: the item in the modifier, and why
  // the check was harder than the difficulty the story chose.
  if (item) record.bonusText = itemText(item);
  if (chosen) {
    record.harderText = reasons.map((reason) => reason.text).join(", ");
    record.harderDetail = `DC ${DIFFICULTY_DCS[chosen]} → ${result.dc}`;
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
  return Array.isArray(row?.checks) ? row.checks : [];
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
  return Array.isArray(row?.dice) ? validDice(row.dice) : [];
}

/** @param {ReadonlyArray<unknown>} dice */
function validDice(dice) {
  return dice.every((die) => Number.isInteger(die) && die >= 1 && die <= 20)
    ? dice
    : [];
}
