import {
  characterSheetSegments,
  createNarrativeReview,
} from "@covel/plugin-handlers-utils";

export default function (covel) {
  // The sheet changes as the story goes; in the prompt body it would change
  // the system prompt with it.
  covel.provideExtension("prompt.segment@1", "character-sheets", {
    handler: (_input, ctx) =>
      characterSheetSegments(ctx.world.characters, { locale: ctx.locale }),
  });
  const review = createNarrativeReview(covel.pluginId);
  covel.on("PostContextAssembly", review.context);
  covel.on("PreLLMCall", review.prepare);
  covel.on("PostLLMResponse", review.review);
  covel.on("TurnStop", review.cleanup);
}
