import {
  actingCharacterOf,
  pickLocaleText,
} from "@covel/plugin-handlers-utils";
import {
  harderContext,
  loadCheckPlan,
  modifierLine,
  readBag,
} from "../../lib/check-plan.js";
import { DIFFICULTY_DCS, MODIFIER_LIMIT } from "../../lib/check-rules.js";
import {
  costContext,
  loadCostPlan,
  PROGRESS_NAMESPACE,
  progressRecord,
} from "../../lib/consequences.js";
import { rememberPool } from "../../lib/turn-pool.js";

const DICE_COUNT = 3;
const D20_SIDES = 20;
const ROLLS_NAMESPACE = "rolls";

/**
 * Pre-roll this turn's dice pool. Runs every turn in the `pre-turn` stage so
 * the narrative engine receives the pool (via its `input.inject` of
 * `checkContext`) before it writes any outcome — success/failure becomes an
 * auditable roll + attribute modifier vs DC instead of LLM freestyle.
 *
 * @type {import("@covel/plugin-handlers-utils").PluginFunctionHandler}
 */
export default async function handler(ctx) {
  // The upper bound is exclusive → 1..20 inclusive.
  const dice = Array.from({ length: DICE_COUNT }, () =>
    ctx.random.int(1, D20_SIDES + 1),
  );
  // A settled tabletop form owns the checks of its turn. The narrative then
  // gets no dice table, and the guard has nothing to compare a receipt with.
  const sourceTurnId = ctx.execution?.sourceTurnId ?? ctx.turnId;
  const owned =
    ctx.inputs?.tabletopCheck?.value?.resolvedTurnId === sourceTurnId;
  const player = actingCharacterOf(
    ctx.playerActions ?? [],
    ctx.world?.characters ?? [],
    ctx.world?.seats ?? [],
  );
  const bag = owned ? null : await readBag(ctx);
  const costPlan = owned ? null : await loadCostPlan(ctx, bag);
  const checkPlan = owned
    ? null
    : await loadCheckPlan(ctx, { player, bag, clocks: costPlan?.clocks });
  // For the guard that checks the receipt while the narrative still runs.
  if (!owned)
    rememberPool(ctx.sessionId, ctx.turnId, dice, { costPlan, checkPlan });

  return {
    outcome: "success",
    value: {
      // Same-execution source for recorder's declared `inputs.dicePool`. Not
      // part of `action-check@1`: other plugins read only `checkContext`.
      dice,
      // Private too: the modifiers and harder checks the narrative is told,
      // and what a failed check of this turn costs, for the recorder.
      ...(checkPlan ? { checkPlan } : {}),
      ...(costPlan ? { costPlan } : {}),
      checkContext: owned
        ? ownedContext(ctx.locale)
        : [
            buildCheckContext(dice, ctx.locale, checkPlan),
            harderContext(checkPlan, ctx.locale),
            costContext(costPlan, ctx.world, ctx.locale),
          ]
            .filter(Boolean)
            .join("\n\n"),
    },
    effects: {
      pluginData: [
        // Audit trail: the raw pool survives even when the narrative never uses it.
        { namespace: ROLLS_NAMESPACE, key: ctx.turnId, value: { dice } },
        ...(await clockDisplays(ctx, costPlan)),
      ],
    },
  };
}

/**
 * The clock records the panel draws, written only when the world changed
 * one (a new clock, another name or size). Their progress is changed by the
 * recorder alone.
 */
async function clockDisplays(ctx, plan) {
  if (!plan || !ctx.pluginData?.get) return [];
  const writes = [];
  for (const clock of Object.values(plan.clocks)) {
    const stored = await ctx.pluginData.get(PROGRESS_NAMESPACE, clock.id);
    const value = progressRecord(clock, clock.filled, stored?.fullTurn);
    if (JSON.stringify(stored) !== JSON.stringify(value))
      writes.push({ namespace: PROGRESS_NAMESPACE, key: clock.id, value });
  }
  return writes;
}

/** What the narrative reads in a turn whose check a tabletop form settled. */
function ownedContext(locale) {
  return pickLocaleText(
    locale,
    "## 本回合判定\n\n本回合的检定已由提交的 tabletopCheck 回执结算。不要再做骰子判定，也不要发射 `check.resolved`。",
    "## Dice checks for this turn\n\nThe submitted tabletopCheck receipt settled the check of this turn. Do not make a dice check and do not emit `check.resolved`.",
  );
}

function signed(value) {
  return value > 0 ? `+${value}` : `${value}`;
}

/**
 * The player character's check attributes with the modifier each converts
 * to (`loadCheckPlan` in `lib/check-plan.js`), and the item that adds to it.
 * The narrative reads the modifier here instead of guessing one from a bare
 * value — a 2/5 is +4, not +2.
 *
 * @param {any} plan The check plan.
 */
function modifierBlock(plan, locale) {
  const entries = Object.values(plan?.modifiers ?? {});
  if (entries.length === 0) return "";
  const items = entries.map((entry) => modifierLine(entry, locale));
  const carried = entries.some((entry) => entry.item);
  return pickLocaleText(
    locale,
    [
      "玩家角色检定属性的修正（已按量程换算：修正 = (数值 − 下限) ÷ 量程 × 10）：",
      ...items,
      ...(carried
        ? [
            "括号里是属性本身的修正和随身物品带来的修正，箭头后的总修正已经算进去了。",
          ]
        : []),
      "检定只用表中的属性，修正按此表读取。生命、信任这类不在表中的数值不用来检定。",
    ],
    [
      "Modifiers of the player character's check attributes (converted from their range: modifier = (value - min) ÷ range × 10):",
      ...items,
      ...(carried
        ? [
            "In brackets: the attribute's own modifier and the item the player carries that adds to it. The total after the arrow already includes the item.",
          ]
        : []),
      "A check uses only an attribute in this list, with the modifier given here. Values that are not listed, such as health or trust, are not used for checks.",
    ],
  ).join("\n");
}

/**
 * One table cell: what a check gives at one difficulty. The narrative reads
 * the outcome here; it does not add or compare numbers itself.
 *
 * @param {number} roll
 * @param {number} dc
 * @param {{ critSuccess: string, critFailure: string, success: string, failure: string, successFrom: (modifier: string) => string }} words
 */
function cell(roll, dc, words) {
  if (roll === 20) return words.critSuccess;
  if (roll === 1) return words.critFailure;
  const needed = dc - roll;
  if (needed <= -MODIFIER_LIMIT) return words.success;
  if (needed > MODIFIER_LIMIT) return words.failure;
  return words.successFrom(signed(needed));
}

/** @param {ReadonlyArray<number>} dice */
function table(dice, header, words) {
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...dice.map(
      (roll, index) =>
        `| ${index + 1} | ${roll} | ${Object.values(DIFFICULTY_DCS)
          .map((dc) => cell(roll, dc, words))
          .join(" | ")} |`,
    ),
  ].join("\n");
}

/**
 * Render the turn's checks and the check rules as a markdown block for the
 * narrative engine's prompt. The rules mirror the `check.resolved` event
 * contract declared by `dice-check/recorder`. Consumers of `action-check@1`
 * carry no dice rules of their own, so this block must stay self-contained:
 * everything the narrative needs to resolve and report a check is stated here.
 *
 * The narrative decides the attribute and the difficulty. It does not choose
 * a die and it does not calculate: each check has one row, the row gives the
 * outcome for every difficulty, and the modifier of each check attribute is
 * pre-computed in the modifier list.
 *
 * @param {ReadonlyArray<number>} dice
 * @param {string | undefined} locale
 * @param {any} plan The check plan of the turn.
 * @returns {string}
 */
function buildCheckContext(dice, locale, plan) {
  const dcs = Object.entries(DIFFICULTY_DCS);
  const modifiers = modifierBlock(plan, locale);
  const step2 = modifiers
    ? pickLocaleText(
        locale,
        "2. 从下方修正表选出这个行动用到的属性，把它填入回执的 attribute，修正从该表读取。",
        "2. Choose the attribute in the modifier list below that the action uses, put it in the receipt's `attribute`, and read its modifier in that list.",
      )
    : pickLocaleText(
        locale,
        "2. 没有可用的有量程能力属性，修正取 0，回执中省略 attribute。生命、信任等数值不用来检定，不要编造属性或修正。",
        "2. No ranged ability is available. Use modifier 0 and omit attribute from the receipt. Values such as health or trust are not used for checks. Do not invent an attribute or modifier.",
      );
  const english = [
    "## Dice checks for this turn",
    "",
    `${dice.length} d20 are rolled for this turn. The first risky action uses check 1, the second uses check 2, the third uses check 3. You must use them in this order. You must not skip a check.`,
    "",
    "For each action with a real risk of failure (picking a lock, sneaking, persuading, climbing, a move in combat):",
    "",
    `1. Choose the difficulty from the fiction, before you look at the row: ${dcs.map(([name, dc]) => `${name} (DC ${dc})`).join(", ")}.`,
    step2,
    "3. Read the outcome in the row of the check, in the column of the difficulty. Do not calculate the outcome in another way.",
    "",
    ...(modifiers.length > 0 ? [modifiers, ""] : []),
    table(dice, ["check", "d20", ...dcs.map(([name]) => name)], {
      critSuccess: "critical success",
      critFailure: "critical failure",
      success: "success",
      failure: "failure",
      successFrom: (modifier) =>
        `success if modifier is ${modifier} or more, else failure`,
    }),
    "",
    "## Check rules",
    "",
    '- A d20 of 20 is a critical success and a d20 of 1 is a critical failure, with every modifier. A critical success gives more than the player hoped for. A critical failure adds a complication; it is more than "it did not work".',
    "- When all checks of this turn are resolved and before you write the prose, call emit-event one time with the topic `check.resolved`. `checks` holds every check in order. Each item has `action`, `modifier`, `difficulty` and `outcome`. Include `attribute` only when an attribute is used. The system adds the d20, the DC and the total.",
    "- If an outcome is not the one in the table, the event is rejected and the message gives the correct outcomes. Send the event again with those outcomes, then write the prose to match them.",
    "- An everyday action without a risk of failure gets no check.",
  ].join("\n");
  const names = { easy: "轻松", normal: "普通", hard: "困难", extreme: "极难" };
  const simplifiedChinese = [
    "## 本回合判定",
    "",
    `本回合已掷好 ${dice.length} 颗 d20。第一个有风险的行动用判定 1，第二个用判定 2，第三个用判定 3。必须按这个顺序使用，不能跳过。`,
    "",
    "对每个**有失败风险**的行动（撬锁、潜行、说服、攀爬、战斗动作等）：",
    "",
    `1. 先根据情境定难度，定好之前不要看那一行：${dcs.map(([name, dc]) => `${names[name]} ${name}（DC ${dc}）`).join("、")}。`,
    step2,
    "3. 在这次判定所在的行、所选难度所在的列读出结果。不要用别的方法计算结果。",
    "",
    ...(modifiers.length > 0 ? [modifiers, ""] : []),
    table(dice, ["判定", "d20", ...dcs.map(([name]) => name)], {
      critSuccess: "大成功 critical-success",
      critFailure: "大失败 critical-failure",
      success: "成功 success",
      failure: "失败 failure",
      successFrom: (modifier) => `修正 ≥ ${modifier} 为成功，否则失败`,
    }),
    "",
    "## 判定规则",
    "",
    "- d20 为 20 是大成功（critical-success），为 1 是大失败（critical-failure），与修正无关。大成功给出超出预期的收获；大失败引入复杂后果，而不是简单的「没成功」。",
    "- 在本回合全部判定完成后、写正文之前，用 emit-event 发射**一次** `check.resolved` 事件。`checks` 按顺序放入每一次判定，每项包含 `action`、`modifier`、`difficulty` 和 `outcome`。仅在使用属性时填写 `attribute`。d20、DC 和合计由系统补上。",
    "- 如果某项 outcome 与表中结果不一致，事件会被退回，退回消息给出正确结果。按那些结果重新发射事件，再据此写正文。",
    "- 无失败风险的日常行动不判定。",
  ].join("\n");
  return pickLocaleText(locale, simplifiedChinese, english);
}
