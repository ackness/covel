import { pickLocaleText } from "@covel/plugin-handlers-utils";
import { attributeName, checkAttributes } from "./attributes.js";
import { attributeIds } from "./check-plan.js";

/**
 * The cost of a failed check, read from the world.
 *
 * A world lists what a failed check costs (`check.consequences@1`, in the
 * `consequences` namespace) and the clocks those costs fill
 * (`check.clocks@1`, in `clocks`). The roller turns them into a plan at the
 * start of the turn: the entries that can be paid now (the item is carried,
 * the clock is not full) with what the narrative is told. The recorder pays
 * the cost of each verified failed check from the same plan, and the review
 * hook uses it to see whether the prose shows the cost. All three resolve a
 * check through `resolveCost`, so the narrative is told the cost that is paid.
 */

export const CONSEQUENCES_NAMESPACE = "consequences";
export const CLOCKS_NAMESPACE = "clocks";
export const PROGRESS_NAMESPACE = "clock-progress";
export const FAILED_OUTCOMES = Object.freeze(["failure", "critical-failure"]);

/** @param {unknown} value */
function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** @param {unknown} value @param {number} fallback */
function count(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** @param {unknown} raw */
function readClock(raw) {
  const id = text(raw?.id);
  const name = text(raw?.name);
  const segments = count(raw?.segments, 0);
  if (!id || !name || segments < 2) return null;
  return {
    id,
    name,
    segments,
    full: text(raw?.full) ?? "",
    // Check attributes that are one step harder once the clock is full.
    raises: Array.isArray(raw?.raises)
      ? raw.raises.map(text).filter(Boolean)
      : [],
  };
}

/** @param {unknown} raw */
function readEntry(raw) {
  const id = text(raw?.id);
  const description = text(raw?.text);
  const cost = raw?.cost;
  if (!id || !description || !cost || typeof cost !== "object") return null;
  const outcome = FAILED_OUTCOMES.includes(raw.outcome)
    ? raw.outcome
    : undefined;
  const base = {
    id,
    ...(text(raw.attribute) ? { attribute: text(raw.attribute) } : {}),
    ...(outcome ? { outcome } : {}),
    text: description,
    cues: Array.isArray(raw.cues) ? raw.cues.map(text).filter(Boolean) : [],
  };
  if (cost.kind === "item" && text(cost.item))
    return {
      ...base,
      cost: {
        kind: "item",
        item: text(cost.item),
        quantity: count(cost.quantity, 1),
      },
    };
  if (cost.kind === "clock" && text(cost.clock))
    return {
      ...base,
      cost: {
        kind: "clock",
        clock: text(cost.clock),
        ticks: count(cost.ticks, 1),
      },
    };
  return null;
}

async function list(ctx, namespace) {
  if (!ctx.pluginData?.list) return [];
  return (await ctx.pluginData.list(namespace)).map(({ value }) => value);
}

/**
 * The cost plan of this turn, or null when the world gives failed checks no
 * cost. The plan is plain data: it goes to the recorder as a runtime input
 * and stays in this process for the review hook. Without a bag, item costs
 * cannot be paid and are left out of the plan.
 *
 * @param {import("@covel/plugin-handlers-utils").PluginFunctionContext} ctx
 * @param {Awaited<ReturnType<typeof import("./check-plan.js").readBag>>} bag
 */
export async function loadCostPlan(ctx, bag) {
  const entries = (await list(ctx, CONSEQUENCES_NAMESPACE))
    .map(readEntry)
    .filter(Boolean);
  if (entries.length === 0) return null;
  const progress = new Map(
    (await list(ctx, PROGRESS_NAMESPACE))
      .filter((record) => typeof record?.id === "string")
      .map((record) => [record.id, record]),
  );
  const clocks = {};
  for (const clock of (await list(ctx, CLOCKS_NAMESPACE)).map(readClock)) {
    if (!clock) continue;
    const filled = progress.get(clock.id)?.filled;
    clocks[clock.id] = {
      ...clock,
      filled: Number.isInteger(filled)
        ? Math.min(Math.max(filled, 0), clock.segments)
        : 0,
    };
  }
  const itemNames = [
    ...new Set(
      entries
        .filter((entry) => entry.cost.kind === "item")
        .map((entry) => entry.cost.item.toLowerCase()),
    ),
  ];
  const held = bag && itemNames.length > 0 ? await bag.held(itemNames) : {};
  const attributes = attributeIds(ctx.world);
  const ledger = newLedger();
  return {
    attributes,
    held,
    clocks,
    entries: entries.filter((entry) =>
      payable({ held, clocks }, entry, ledger),
    ),
  };
}

/**
 * The stored state of a clock, which the clocks panel draws. `fullTurn` is
 * the number of the turn that filled it.
 */
export function progressRecord(clock, filled, fullTurn) {
  return {
    id: clock.id,
    name: clock.name,
    segments: clock.segments,
    filled,
    progressText: `${filled}/${clock.segments}`,
    isFull: filled >= clock.segments,
    whenFull: clock.full,
    ...(Number.isInteger(fullTurn) ? { fullTurn } : {}),
  };
}

/** What has been paid this turn, so a second failure does not pay it again. */
export function newLedger() {
  return { items: new Map(), ticks: new Map(), refused: new Set() };
}

function payable(plan, entry, ledger) {
  if (ledger.refused.has(entry.id)) return false;
  const { cost } = entry;
  if (cost.kind === "item") {
    const name = cost.item.toLowerCase();
    return (
      (plan.held[name] ?? 0) - (ledger.items.get(name) ?? 0) >= cost.quantity
    );
  }
  const clock = plan.clocks[cost.clock];
  return (
    Boolean(clock) &&
    clock.filled + (ledger.ticks.get(cost.clock) ?? 0) < clock.segments
  );
}

/**
 * The entry that a failed check pays, or null. The most specific entry wins:
 * one for the check's attribute before one for any attribute, one for the
 * outcome before one for both failed outcomes; the first in the file wins a
 * tie. An entry that cannot be paid any more (the item is gone, the clock is
 * full) is passed over. The chosen entry is written into `ledger`.
 *
 * @param {NonNullable<Awaited<ReturnType<typeof loadCostPlan>>>} plan
 * @param {{ attribute?: string, outcome: string }} check
 * @param {ReturnType<typeof newLedger>} ledger
 */
export function resolveCost(plan, check, ledger) {
  if (!FAILED_OUTCOMES.includes(check.outcome)) return null;
  const attribute = check.attribute
    ? plan.attributes[check.attribute.trim().toLowerCase()]
    : undefined;
  let best = null;
  let bestScore = -1;
  for (const entry of plan.entries) {
    if (entry.attribute && entry.attribute !== attribute) continue;
    if (entry.outcome && entry.outcome !== check.outcome) continue;
    if (!payable(plan, entry, ledger)) continue;
    const score = (entry.attribute ? 2 : 0) + (entry.outcome ? 1 : 0);
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }
  if (!best) return null;
  const { cost } = best;
  if (cost.kind === "item") {
    const name = cost.item.toLowerCase();
    ledger.items.set(name, (ledger.items.get(name) ?? 0) + cost.quantity);
  } else {
    ledger.ticks.set(
      cost.clock,
      (ledger.ticks.get(cost.clock) ?? 0) + cost.ticks,
    );
  }
  return best;
}

/**
 * Give back an item entry that could not be paid, so `resolveCost` chooses
 * another one for the same check.
 */
export function refuse(ledger, entry) {
  ledger.refused.add(entry.id);
  if (entry.cost.kind !== "item") return;
  const name = entry.cost.item.toLowerCase();
  ledger.items.set(name, (ledger.items.get(name) ?? 0) - entry.cost.quantity);
}

/** "Cold and wet +1" or "Phone −1": what the cost changes, for people. */
export function costDetail(plan, entry) {
  const { cost } = entry;
  if (cost.kind === "item") return `${cost.item} −${cost.quantity}`;
  return `${plan.clocks[cost.clock]?.name ?? cost.clock} +${cost.ticks}`;
}

/**
 * The section of the check context that says what a failed check costs and
 * how full each clock is. Empty when the plan has nothing to say.
 *
 * @param {Awaited<ReturnType<typeof loadCostPlan>>} plan
 * @param {import("@covel/plugin-handlers-utils").ExtensionWorldModel | undefined} world
 * @param {string | undefined} locale
 */
export function costContext(plan, world, locale) {
  if (!plan) return "";
  const outcomeName = {
    failure: pickLocaleText(locale, "失败", "failure"),
    "critical-failure": pickLocaleText(locale, "大失败", "critical failure"),
    both: pickLocaleText(locale, "失败或大失败", "failure or critical failure"),
  };
  const costOf = (attribute, outcome) =>
    resolveCost(plan, { attribute, outcome }, newLedger());
  const lines = [];
  // One line for each subject and outcome; one line for both outcomes when
  // they cost the same. An attribute that costs what any check costs is
  // left to the "any other check" lines.
  const add = (subject, [failure, critical], generic = []) => {
    const line = (outcome, entry) =>
      pickLocaleText(
        locale,
        `- ${subject}${outcomeName[outcome]}：${entry.text}（${costDetail(plan, entry)}）`,
        `- ${subject}, ${outcomeName[outcome]}: ${entry.text} (${costDetail(plan, entry)})`,
      );
    if (failure && failure === critical) {
      if (failure !== generic[0] || critical !== generic[1])
        lines.push(line("both", failure));
      return;
    }
    if (failure && failure !== generic[0]) lines.push(line("failure", failure));
    if (critical && critical !== generic[1])
      lines.push(line("critical-failure", critical));
  };
  const generic = FAILED_OUTCOMES.map((outcome) => costOf(undefined, outcome));
  for (const attribute of checkAttributes(world))
    add(
      pickLocaleText(
        locale,
        `${attributeName(attribute, locale)}检定`,
        attributeName(attribute, locale),
      ),
      FAILED_OUTCOMES.map((outcome) => costOf(attribute.id, outcome)),
      generic,
    );
  add(pickLocaleText(locale, "其他检定", "Any other check"), generic);
  const clocks = Object.values(plan.clocks).map((clock) =>
    clock.filled >= clock.segments
      ? pickLocaleText(
          locale,
          `- ${clock.name}：已满。${clock.full} 这一后果在之后的故事里持续有效。`,
          `- ${clock.name}: full. ${clock.full} This stays true for the rest of the story.`,
        )
      : pickLocaleText(
          locale,
          `- ${clock.name}：${clock.filled}/${clock.segments}。填满时：${clock.full}`,
          `- ${clock.name}: ${clock.filled}/${clock.segments}. When it fills: ${clock.full}`,
        ),
  );
  if (lines.length === 0 && clocks.length === 0) return "";
  return [
    pickLocaleText(locale, "## 失败的代价", "## Cost of failure"),
    "",
    ...(lines.length
      ? [
          pickLocaleText(
            locale,
            "在这个世界里，失败的检定一定有代价。发出 `check.resolved` 后，系统按下表为每个失败的检定结算代价并展示给玩家。在这次检定的正文里写出这个代价，不要淡化，也不要跳过：",
            "In this world a failed check always costs something. When you send `check.resolved`, the system applies the cost below for each failed check and shows it to the player. Write that cost into the prose of the check; do not soften or skip it:",
          ),
          ...lines,
          "",
        ]
      : []),
    ...(clocks.length
      ? [pickLocaleText(locale, "进度时钟：", "Clocks:"), ...clocks]
      : []),
  ].join("\n");
}
