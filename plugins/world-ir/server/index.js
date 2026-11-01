import reviewOutput from "./review-output.js";
import makeSubmitWorldFacts from "../tools/submit-world-facts.js";
import extractionContext from "./extraction-context.js";

export default function (covel) {
  covel.on("ReviewAgentOutput", reviewOutput);
  covel.registerTool(makeSubmitWorldFacts(covel.toolkit));
  covel.on("PostContextAssembly", extractionContext);
}
