import { appendSummaryEntries, labelText } from "@covel/plugin-handlers-utils";
import createAdvanceWorldTime from "../tools/advance-world-time.js";
import time from "../rpc/time.js";
import { worldTimeSchema } from "../schema.js";
import { describeTime } from "../clock.js";

export default function register(covel) {
  covel.registerTool(createAdvanceWorldTime(covel.toolkit));
  covel.registerRpc("time", time, {
    description: "Read committed world time without advancing it",
  });
  // The committed clock, as one line of the session summary.
  covel.provideExtension("ui.slot@1", "summary", {
    async handler({ previous }, ctx) {
      const state = (await ctx.pluginData.get("clock", "current"))?.value;
      const definition =
        state?.schemaVersion === 1
          ? worldTimeSchema.safeParse(state.definition)
          : undefined;
      if (!definition?.success) return appendSummaryEntries(previous, []);
      return appendSummaryEntries(previous, [
        {
          id: "time.now",
          kind: "text",
          label: labelText(ctx, "Time"),
          value: describeTime(definition.data, state.tick, ctx.locale).display,
        },
      ]);
    },
  });
}
