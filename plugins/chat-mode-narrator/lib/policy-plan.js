import { z } from "zod";
import { STORY_LIMITS } from "@covel/plugin-handlers-utils";

export const policyPlanSchema = z.strictObject({
  status: z.enum(["available", "unavailable", "invalid-selection"]),
  cast: z
    .array(z.string().min(1).max(STORY_LIMITS.speaker))
    .max(STORY_LIMITS.present),
  actors: z
    .array(
      z.strictObject({
        character: z.string().min(1).max(STORY_LIMITS.speaker),
        reason: z.string().max(500).optional(),
        instruction: z.string().max(2_000).optional(),
      }),
    )
    .max(STORY_LIMITS.present),
  brief: z.string().min(1).max(6_000),
  order: z.enum(["sequential", "parallel"]),
  narrator: z.enum(["before", "after", "none"]),
  yieldHint: z.enum(["user", "continue"]),
});
