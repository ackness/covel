import { z } from "zod";

const common = {
  turnId: z.string().min(1),
  source: z.object({
    pluginId: z.string().min(1),
    runtimeId: z.string().min(1),
    resultId: z.string().min(1),
  }),
  options: z
    .array(
      z.object({
        id: z.string().min(1),
        text: z.string().min(1),
        probability: z.number().min(0).max(1).optional(),
      }),
    )
    .min(2)
    .max(6),
};

/** The choice-recommendations capability publishes recommendations/current. */
export const choiceRecommendationSchema = z
  .discriminatedUnion("status", [
    z.object({
      ...common,
      status: z.literal("ready"),
      selectedId: z.string().min(1),
      model: z.string().min(1),
      provider: z.string().optional(),
    }),
    z.object({
      ...common,
      status: z.literal("unavailable"),
      reason: z.enum(["unconfigured", "unsupported", "failed"]),
    }),
  ])
  .superRefine((record, ctx) => {
    const ids = new Set(record.options.map((option) => option.id));
    if (
      ids.size !== record.options.length ||
      (record.status === "ready" && !ids.has(record.selectedId))
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Recommendation must reference distinct, current options",
      });
    }
    const probabilities = record.options.filter(
      (option) => option.probability !== undefined,
    );
    if (
      probabilities.length > 0 &&
      probabilities.length !== record.options.length
    ) {
      ctx.addIssue({
        code: "custom",
        message: "A distribution must cover every option",
      });
    }
  });
