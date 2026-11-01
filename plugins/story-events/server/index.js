import reviewOutput from "./review-output.js";
import createPlanStoryEvents from "../tools/plan-story-events.js";

export default function register(covel) {
  covel.on("ReviewAgentOutput", reviewOutput);
  covel.registerTool(createPlanStoryEvents(covel.toolkit));
}
