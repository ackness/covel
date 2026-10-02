import createPlanStoryEvents from "../tools/plan-story-events.js";

export default function register(covel) {
  covel.registerTool(createPlanStoryEvents(covel.toolkit));
}
