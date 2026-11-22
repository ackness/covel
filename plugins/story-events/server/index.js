import { ACTIVE_OPTIONS } from "../lib/constants.js";
import { mergeStageChoices } from "../lib/options.js";
import createPlanStoryEvents from "../tools/plan-story-events.js";

export default function register(covel) {
  covel.registerTool(createPlanStoryEvents(covel.toolkit));
  covel.provideExtension("ui.slot@1", "choices", {
    async handler({ previous }, ctx) {
      const activeRows = await ctx.pluginData.list(ACTIVE_OPTIONS);
      return mergeStageChoices(previous, activeRows, ctx);
    },
  });
}
