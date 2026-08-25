const CHECKS_NAMESPACE = "checks";
const MESSAGE_NAMESPACE = "message";

const OUTCOMES = new Set([
  "success",
  "failure",
  "critical-success",
  "critical-failure",
]);
const DIFFICULTY_DCS = Object.freeze({
  easy: 8,
  normal: 12,
  hard: 16,
  extreme: 20,
});

// Presentation is computed here so the json-render specs stay dumb: they just
// bind label/color/critical fields off the stored record.
const OUTCOME_PRESENTATION = {
  success: {
    label: { zh: "成功", en: "Success" },
    color: "green",
    critical: false,
  },
  failure: {
    label: { zh: "失败", en: "Failure" },
    color: "red",
    critical: false,
  },
  "critical-success": {
    label: { zh: "大成功", en: "Critical success" },
    color: "purple",
    critical: true,
  },
  "critical-failure": {
    label: { zh: "大失败", en: "Critical failure" },
    color: "amber",
    critical: true,
  },
};

/**
 * Record the `check.resolved` receipt batch emitted by the narrative engine.
 * The payload carries ALL checks of the turn in one `checks` array because
 * emit-event dedupes by topic per turn — a second emission would be dropped.
 * Defensive at the trust boundary: emit-event validates payloads against the
 * event schema, and this handler additionally proves each receipt against the
 * immutable pre-rolled pool and the deterministic check rules.
 *
 * @param {import('@covel/plugin-loader').FunctionHandlerContext} ctx
 */
export default async function handler(ctx) {
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
  for (const raw of rawChecks) {
    const expectedRoll = dice[previousChecks.length + records.length];
    if (expectedRoll === undefined) break;
    const record = parseCheck(raw, expectedRoll);
    if (record !== null) records.push(record);
  }
  if (records.length === 0) {
    return {
      outcome: "skipped",
      skipReason:
        "check.resolved payload carried no auditable check (roll must consume this turn's pre-rolled pool; modifier, total, difficulty, DC, and outcome must agree)",
    };
  }

  const firstSeq = await nextSequence(ctx);
  const entries = records.map((record, index) => {
    const presentation = OUTCOME_PRESENTATION[record.outcome];
    return {
      ...record,
      turnId: ctx.turnId,
      seq: firstSeq + index,
      outcomeLabel: presentation.label,
      outcomeColor: presentation.color,
      critical: presentation.critical,
      rollText: buildRollText(record),
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
          },
        },
      ],
    },
  };
}

/**
 * Validate and normalize the event payload. Returns null when a required
 * field is missing, malformed, or inconsistent with the pre-rolled die and
 * deterministic check rules.
 *
 * @param {unknown} data
 * @param {number} expectedRoll
 */
function parseCheck(data, expectedRoll) {
  if (!data || typeof data !== "object") return null;
  const payload = /** @type {Record<string, unknown>} */ (data);

  const action =
    typeof payload.action === "string" ? payload.action.trim() : "";
  const roll = asInteger(payload.roll);
  const modifier = asInteger(payload.modifier);
  const dc = asInteger(payload.dc);
  const difficulty =
    typeof payload.difficulty === "string" &&
    Object.hasOwn(DIFFICULTY_DCS, payload.difficulty)
      ? payload.difficulty
      : null;
  const total = asInteger(payload.total);
  const outcome = OUTCOMES.has(payload.outcome) ? payload.outcome : null;
  if (
    !action ||
    roll !== expectedRoll ||
    modifier === null ||
    dc === null ||
    difficulty === null ||
    dc !== DIFFICULTY_DCS[difficulty] ||
    total !== roll + modifier
  ) {
    return null;
  }
  if (!outcome || outcome !== expectedOutcome(roll, total, dc)) return null;

  const record = { action, roll, modifier, dc, difficulty, total, outcome };
  if (typeof payload.attribute === "string" && payload.attribute.trim()) {
    record.attribute = payload.attribute.trim();
  }
  return record;
}

/** @param {number} roll @param {number} total @param {number} dc */
function expectedOutcome(roll, total, dc) {
  if (roll === 20) return "critical-success";
  if (roll === 1) return "critical-failure";
  return total >= dc ? "success" : "failure";
}

/** @param {unknown} value */
function asInteger(value) {
  return Number.isInteger(value) ? /** @type {number} */ (value) : null;
}

/**
 * Human-readable roll expression, e.g. "14 + 3 = 17 vs DC 12". Modifier and
 * DC render only when the receipt carried them.
 *
 * @param {{ roll: number, modifier?: number, total: number, dc?: number }} record
 */
function buildRollText(record) {
  const modifier = record.modifier;
  const base =
    modifier === undefined
      ? `${record.roll}`
      : `${record.roll} ${modifier >= 0 ? "+" : "-"} ${Math.abs(modifier)}`;
  const vs = record.dc === undefined ? "" : ` vs DC ${record.dc}`;
  return `${base} = ${record.total}${vs}`;
}

/**
 * Next per-turn sequence number: count of existing `checks` keys with this
 * turn's prefix, plus one.
 *
 * @param {import('@covel/plugin-loader').FunctionHandlerContext} ctx
 */
async function nextSequence(ctx) {
  if (!ctx.pluginData?.list) return 1;
  const rows = await ctx.pluginData.list(CHECKS_NAMESPACE);
  const prefix = `${ctx.turnId}-`;
  const used = rows.filter(
    (row) => typeof row?.key === "string" && row.key.startsWith(prefix),
  ).length;
  return used + 1;
}

/**
 * Previously recorded checks for this turn's message block, so a second
 * receipt in the same turn appends instead of overwriting.
 *
 * @param {import('@covel/plugin-loader').FunctionHandlerContext} ctx
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
 * @param {import('@covel/plugin-loader').FunctionHandlerContext} ctx
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
