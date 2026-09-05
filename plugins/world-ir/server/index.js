import makeSubmitWorldFacts from "../tools/submit-world-facts.js";
import extractionContext from "./extraction-context.js";

export default function (covel) {
  covel.registerTool(makeSubmitWorldFacts(covel.toolkit));
  covel.on("PostContextAssembly", extractionContext);
}
