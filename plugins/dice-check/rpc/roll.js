import { translate } from "@covel/plugin-handlers-utils";
import { parseDiceNotation, rollDice } from "./dice.js";

function invalidMessage(code, ctx) {
  if (code === "invalid-count")
    return translate(ctx, "Dice count must be between 1 and 100.");
  if (code === "invalid-sides")
    return translate(ctx, "Die sides must be between 2 and 1000.");
  return translate(ctx, "Use NdM dice notation, for example 2d6.");
}

/**
 * Player-facing `/roll` command action.
 *
 * @param {{ args?: { notation?: unknown } } | unknown} payload
 * @param {import("@covel/plugin-handlers-utils").PluginMessageContext} ctx
 */
export default async function roll(payload, ctx) {
  const body = payload && typeof payload === "object" ? payload : {};
  const args = body.args && typeof body.args === "object" ? body.args : {};
  const parsed = parseDiceNotation(args.notation);
  if (!parsed.ok) {
    return {
      ok: false,
      message: invalidMessage(parsed.code, ctx),
      data: { code: parsed.code },
    };
  }

  const result = rollDice(parsed, ctx.random.int);
  const joined = result.rolls.join(", ");
  const message = translate(ctx, "{notation}: {rolls} (total {total})", {
    notation: result.notation,
    rolls: joined,
    total: result.total,
  });
  return { ok: true, message, data: result };
}
