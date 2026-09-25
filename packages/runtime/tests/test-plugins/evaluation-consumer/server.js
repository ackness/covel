import { z } from "zod";

export default function register(covel) {
  covel.registerService({
    name: "evaluate",
    contract: "test/evaluation@1",
    input: z.object({
      state: z.json(),
      options: z.array(z.object({ id: z.string(), text: z.string() })),
    }),
    output: z.object({
      selectedId: z.string(),
      options: z.array(
        z.object({ id: z.string(), text: z.string(), probability: z.number() }),
      ),
    }),
    async handler(input, ctx) {
      const result = await ctx.gateway.evaluate({
        presetId: "evaluation",
        state: input.state,
        signal: ctx.signal,
        questions: {
          recommendation: {
            type: "choice",
            instructions: "Rank supplied options",
            criteria: Object.fromEntries(
              input.options.map((option) => [option.id, option.text]),
            ),
          },
        },
      });
      const answer = result.answers.recommendation;
      return {
        selectedId: answer.choice,
        options: input.options.map((option) => ({
          ...option,
          probability: answer.probabilities[option.id],
        })),
      };
    },
  });
}
