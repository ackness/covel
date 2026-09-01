import { randomInt } from "node:crypto";
import { pickLocaleText } from "@covel/plugin-handlers-utils";
import { parseDiceNotation, rollDice } from "./dice.js";

function invalidMessage(code, locale) {
  if (code === "invalid-count") {
    return pickLocaleText(
      locale,
      "骰子数量必须在 1 到 100 之间。",
      "Dice count must be between 1 and 100.",
    );
  }
  if (code === "invalid-sides") {
    return pickLocaleText(
      locale,
      "骰子面数必须在 2 到 1000 之间。",
      "Die sides must be between 2 and 1000.",
    );
  }
  return pickLocaleText(
    locale,
    "请使用 NdM 骰式，例如 2d6。",
    "Use NdM dice notation, for example 2d6.",
  );
}

/**
 * Player-facing `/roll` command action.
 *
 * @param {{ args?: { notation?: unknown } } | unknown} payload
 * @param {{ locale?: string }} ctx
 */
export default async function roll(payload, ctx) {
  const body = payload && typeof payload === "object" ? payload : {};
  const args = body.args && typeof body.args === "object" ? body.args : {};
  const parsed = parseDiceNotation(args.notation);
  if (!parsed.ok) {
    return {
      ok: false,
      message: invalidMessage(parsed.code, ctx.locale),
      data: { code: parsed.code },
    };
  }

  const result = rollDice(parsed, randomInt);
  const joined = result.rolls.join(", ");
  const message = pickLocaleText(
    ctx.locale,
    `${result.notation}：${joined}（合计 ${result.total}）`,
    `${result.notation}: ${joined} (total ${result.total})`,
  );
  return { ok: true, message, data: result };
}
