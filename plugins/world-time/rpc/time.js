import { worldTimeSchema } from "../schema.js";
import { translate } from "@covel/plugin-handlers-utils";
import { describeTime } from "../clock.js";

/** Read committed clock state without initializing or advancing the world. */
export default async function time(_payload, ctx) {
  const row = await ctx.store.getPluginData("clock", "current");
  if (!row) {
    return {
      ok: true,
      message: translate(
        ctx,
        "World time has not been recorded yet. Complete the first narrative turn to view it.",
      ),
      data: { initialized: false },
    };
  }
  const state = row.value;
  if (!state || state.schemaVersion !== 1)
    throw new Error("Invalid stored world time");
  const definition = worldTimeSchema.parse(state.definition);
  const clock = {
    ...state,
    ...describeTime(definition, state.tick, ctx.locale),
  };
  return {
    ok: true,
    message: translate(ctx, "World time: {display}", {
      display: clock.display,
    }),
    data: { initialized: true, ...clock },
  };
}
