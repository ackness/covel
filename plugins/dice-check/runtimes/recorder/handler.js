const CHECKS_NAMESPACE = "checks";
const MESSAGE_NAMESPACE = "message";

const OUTCOMES = new Set([
  "success",
  "failure",
  "critical-success",
  "critical-failure",
]);
const DIFFICULTIES = new Set(["easy", "normal", "hard", "extreme"]);

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
 * Tolerant at the trust boundary: emit-event validates payloads against the
 * event schema, but this handler still re-checks required fields so a stray
 * or hand-crafted event degrades to a skip instead of a crash.
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
  const records = rawChecks.map(parseCheck).filter((record) => record !== null);
  if (records.length === 0) {
    return {
      status: "skipped",
      reason:
        "check.resolved payload carried no valid check (required per check: action, roll, total, outcome)",
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
  const previousChecks = await readTurnChecks(ctx);

  return {
    status: "done",
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
  };
}

/**
 * Validate and normalize the event payload. Returns null when any required
 * field is missing or malformed; malformed OPTIONAL fields are dropped
 * silently instead of failing the whole receipt.
 *
 * @param {unknown} data
 */
function parseCheck(data) {
  if (!data || typeof data !== "object") return null;
  const payload = /** @type {Record<string, unknown>} */ (data);

  const action =
    typeof payload.action === "string" ? payload.action.trim() : "";
  const roll = asInteger(payload.roll);
  const total = asInteger(payload.total);
  const outcome = OUTCOMES.has(payload.outcome) ? payload.outcome : null;
  if (!action || roll === null || roll < 1 || roll > 20 || total === null) {
    return null;
  }
  if (!outcome) return null;

  const record = { action, roll, total, outcome };
  if (typeof payload.attribute === "string" && payload.attribute.trim()) {
    record.attribute = payload.attribute.trim();
  }
  const modifier = asInteger(payload.modifier);
  if (modifier !== null) record.modifier = modifier;
  const dc = asInteger(payload.dc);
  if (dc !== null) record.dc = dc;
  if (DIFFICULTIES.has(payload.difficulty)) {
    record.difficulty = payload.difficulty;
  }
  return record;
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
