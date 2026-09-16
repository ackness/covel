import { createNarrativeReview } from "@covel/plugin-handlers-utils";

export default function (covel) {
  const review = createNarrativeReview(covel.pluginId);
  covel.on("PostContextAssembly", review.context);
  covel.on("PreLLMCall", review.prepare);
  covel.on("PostLLMResponse", review.review);
  covel.on("TurnStop", review.cleanup);
}
