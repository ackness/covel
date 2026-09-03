import makeSubmitWorldFacts from "../tools/submit-world-facts.js";

export default function (covel) {
  covel.registerTool(makeSubmitWorldFacts(covel.toolkit));
}
