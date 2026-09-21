import { z } from "zod";

export const CONTRACT = "demo/choice-recommendation@1";
export const inputSchema = z
  .object({
    presetId: z.string().min(1),
    goal: z.string().min(1).max(2000),
    state: z.json(),
    options: z
      .array(
        z.object({ id: z.string().min(1), text: z.string().min(1).max(500) }),
      )
      .min(2)
      .max(6),
  })
  .superRefine(({ options }, ctx) => {
    if (new Set(options.map(({ id }) => id)).size !== options.length) {
      ctx.addIssue({ code: "custom", message: "Option IDs must be unique" });
    }
  });
export const outputSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    selectedId: z.string(),
    model: z.string(),
    provider: z.string().optional(),
    options: z.array(
      z.object({
        id: z.string(),
        text: z.string(),
        probability: z.number().min(0).max(1).optional(),
      }),
    ),
  }),
  z.object({
    status: z.literal("unavailable"),
    reason: z.enum(["unconfigured", "unsupported", "failed"]),
  }),
]);

export async function recommend(input, ctx) {
  if (!ctx.gateway?.evaluate)
    return { status: "unavailable", reason: "unsupported" };
  try {
    const target = ctx.gateway.resolveSlot({
      presetId: input.presetId,
      fallbackTag: "evaluation",
    });
    if (!target || target.tag !== "evaluation")
      return { status: "unavailable", reason: "unconfigured" };
    const result = await ctx.gateway.evaluate({
      presetId: input.presetId,
      state: input.state,
      questions: {
        recommendation: {
          type: "choice",
          instructions: input.goal,
          criteria: Object.fromEntries(
            input.options.map(({ id, text }) => [id, text]),
          ),
        },
      },
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(10000)]),
    });
    ctx.signal.throwIfAborted();
    const answer = result.answers.recommendation;
    if (
      answer.type !== "choice" ||
      !input.options.some(({ id }) => id === answer.choice)
    )
      throw new Error("Unknown choice");
    // A winner does not imply a probability distribution. Never synthesize one.
    if (
      answer.probabilities &&
      input.options.some(
        ({ id }) =>
          !Number.isFinite(answer.probabilities[id]) ||
          answer.probabilities[id] < 0 ||
          answer.probabilities[id] > 1,
      )
    ) {
      throw new Error("Incomplete probability distribution");
    }
    return outputSchema.parse({
      status: "ready",
      selectedId: answer.choice,
      model: result.model,
      provider: result.provider,
      options: input.options.map((option) => ({
        ...option,
        ...(answer.probabilities
          ? { probability: answer.probabilities[option.id] }
          : {}),
      })),
    });
  } catch {
    ctx.signal.throwIfAborted();
    return { status: "unavailable", reason: "failed" };
  }
}

/** @param {import('@covel/runtime').PluginAPI} covel */
export default function register(covel) {
  covel.registerService({
    name: "recommend",
    contract: CONTRACT,
    description: "Rank supplied actions using an evaluation model",
    input: inputSchema,
    output: outputSchema,
    handler: recommend,
  });
}
