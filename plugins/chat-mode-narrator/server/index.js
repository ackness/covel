import {
  characterSheetSegments,
  createNarrativeReview,
  currentCharacterOf,
  primarySeat,
} from "@covel/plugin-handlers-utils";

export default function (covel) {
  // The sheet changes as the story goes; in the prompt body it would change
  // the system prompt with it.
  covel.provideExtension("prompt.segment@1", "character-sheets", {
    handler: (_input, ctx) =>
      characterSheetSegments(ctx.world.characters, {
        currentCharacterId: currentCharacterOf(
          primarySeat(ctx.world.seats),
          ctx.world.characters,
          ctx.world.seats,
        )?.id,
        locale: ctx.locale,
        schema: ctx.world.characterSchema,
      }),
  });
  const review = createNarrativeReview(covel.pluginId);
  const storyOnly = (handler) => (ctx, payload) =>
    ctx.runtimeId === `${covel.pluginId}/narrate`
      ? handler(ctx, payload)
      : { action: "continue" };
  covel.on("PostContextAssembly", storyOnly(review.context));
  covel.on("PreLLMCall", storyOnly(review.prepare));
  covel.on("PostLLMResponse", storyOnly(review.review));
  covel.on("TurnStop", review.cleanup);
}
