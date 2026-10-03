import { randomInt } from "node:crypto";
import { pickLocaleText } from "@covel/plugin-handlers-utils";

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
  // randomInt's upper bound is exclusive → 1..20 inclusive.
  const dice = Array.from({ length: DICE_COUNT }, () =>
    randomInt(1, D20_SIDES + 1),
  );

  return {
    outcome: "success",
    value: {
      // Same-execution source for recorder's declared `inputs.dicePool`. Not
      // part of `action-check@1`: other plugins read only `checkContext`.
      dice,
      checkContext: buildCheckContext(dice, ctx.locale),
    },
    effects: {
      // Audit trail: the raw pool survives even when the narrative never uses it.
      pluginData: [
        { namespace: ROLLS_NAMESPACE, key: ctx.turnId, value: { dice } },
      ],
    },
  };
}

/**
 * Render the dice pool + check rules as a markdown block for the narrative
 * engine's prompt. The rules mirror the `check.resolved` event contract
 * declared by `dice-check/recorder`. Consumers of `action-check@1` carry no dice
 * rules of their own, so this block must stay self-contained: everything the
 * narrative needs to resolve and report a check is stated here.
 *
 * @param {ReadonlyArray<number>} dice
 * @param {string | undefined} locale
 * @returns {string}
 */
function buildCheckContext(dice, locale) {
  const pool = dice
    .map((value, index) => `#${index + 1}: ${value}`)
    .join(" / ");

  const english = [
    "## Dice pool for this turn",
    "",
    `Pre-rolled d20s: ${pool}`,
    "",
    "## Check rules",
    "",
    "- When the player attempts an action with a real risk of failure this turn (lockpicking, sneaking, persuasion, climbing, combat moves, ...), consume the unused pre-rolled dice in order (#1 first, then #2, #3)",
    "- Check = die value + relevant attribute modifier (derived from the numeric attributes on the player's character sheet) vs difficulty DC: easy 8 / normal 12 / hard 16 / extreme 20",
    '- A natural 20 is a critical success and a natural 1 is a critical failure, regardless of modifiers: a critical success earns a better-than-expected payoff, a critical failure adds a complication rather than a flat "it didn\'t work"',
    "- If a submitted tabletopCheck receipt is present, that check owns this turn: ignore this dice pool and do not emit `check.resolved`",
    "- Otherwise, after resolving ALL of this turn's dice-pool checks and before writing the prose, emit ONE `check.resolved` event via emit-event carrying every check in its `checks` array (the event dedupes per turn — never emit it twice)",
    "- Risk-free everyday actions get no check and consume no dice",
  ].join("\n");
  const simplifiedChinese = [
    "## 本回合判定骰池",
    "",
    `预掷 d20：${pool}`,
    "",
    "## 判定规则",
    "",
    "- 玩家本回合尝试**有失败风险**的行动时（撬锁、潜行、说服、攀爬、战斗动作等），按顺序消耗未用的预掷骰（先 #1，再 #2、#3）",
    "- 判定 = 骰值 + 相关属性修正（从玩家角色卡的数值属性换算）vs 难度 DC：轻松 8 / 普通 12 / 困难 16 / 极难 20",
    "- 天然 20 为大成功（critical-success）、天然 1 为大失败（critical-failure），无视修正：大成功给出超出预期的收获，大失败引入复杂后果，而不是简单的「没成功」",
    "- 若存在已提交的 tabletopCheck 回执，本回合由该检定独占：忽略此骰池，也不发射 `check.resolved`",
    "- 否则本回合全部骰池判定完成后、写正文之前，用 emit-event 发射**一次** `check.resolved` 事件，把所有骰池判定装进 `checks` 数组（该事件同回合去重，绝不发第二次）",
    "- 无失败风险的日常行动不判定、不掷骰",
  ].join("\n");
  return pickLocaleText(locale, simplifiedChinese, english);
}
