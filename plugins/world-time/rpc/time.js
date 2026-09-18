import { worldTimeSchema } from "@covel/shared";
import { pickLocaleText } from "@covel/plugin-handlers-utils";
import { describeTime } from "../clock.js";

/** Read committed clock state without initializing or advancing the world. */
export default async function time(_payload, ctx) {
  const row = await ctx.store.getPluginData(
    ctx.sessionId,
    ctx.pluginId,
    "clock",
    "current",
  );
  if (!row) {
    return {
      ok: true,
      message: pickLocaleText(
        ctx.locale,
        "世界时间尚未记录；完成首个叙事回合后可查看。",
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
    message: pickLocaleText(
      ctx.locale,
      `世界时间：${clock.display}`,
      `World time: ${clock.display}`,
    ),
    data: { initialized: true, ...clock },
  };
}
