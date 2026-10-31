import { z } from "zod";
import {
  MAX_ACTIONS_PER_SUBMISSION,
  MAX_PLAYER_MESSAGE_CHARS,
  turnActionSchema,
} from "./action-schemas.js";
import { STORY_LIMITS, storySegmentSchema } from "./story-schemas.js";

export const TURN_POLICY_CONTRACT = "turn-policy@1";
export const CHARACTER_ACTOR_CONTRACT = "character-actor@1";

const characterId = z.string().min(1);
const name = z.string().min(1).max(STORY_LIMITS.speaker);
const segments = z
  .array(storySegmentSchema.strict())
  .max(STORY_LIMITS.segments);
const instruction = z.string().max(2_000).optional();
const limits = z.strictObject({
  maxActors: z.number().int().min(0).max(16),
  maxSubagentCalls: z.number().int().min(0).max(64),
});
const policyFields = {
  actions: z
    .array(turnActionSchema)
    .max(MAX_ACTIONS_PER_SUBMISSION)
    .refine(
      (actions) =>
        actions.reduce(
          (total, action) => total + (action.text?.length ?? 0),
          0,
        ) <= MAX_PLAYER_MESSAGE_CHARS,
      "The actions exceed the submission text limit",
    ),
  present: z.array(z.strictObject({ characterId, name })).max(32),
  recentSegments: segments,
};

/** Caller limits can only narrow the host's remaining allowances. */
export const turnPolicyRequestSchema = z.strictObject({
  ...policyFields,
  limits: limits.optional(),
});
/** Providers always receive limits, supplied and bounded by the host. */
export const turnPolicyInputSchema = z.strictObject({
  ...policyFields,
  limits,
});
const planFields = {
  order: z.enum(["sequential", "parallel"]),
  narrator: z.enum(["before", "after", "none"]),
  yieldHint: z.enum(["user", "continue"]),
};
export const turnPolicyOutputSchema = z.strictObject({
  actors: z
    .array(
      z.strictObject({
        characterId,
        reason: z.string().max(500).optional(),
        instruction,
      }),
    )
    .max(32),
  ...planFields,
});
export const characterActorInputSchema = z.strictObject({
  characterId,
  brief: z.string().min(1).max(20_000),
  instruction,
});
export const characterActorOutputSchema = z.strictObject({
  segments: z
    .array(
      z.strictObject({
        kind: z.enum(["dialogue", "action"]),
        text: z.string().min(1).max(4_000),
      }),
    )
    .min(1)
    .max(8),
  intent: z.string().max(2_000).optional(),
});
export const characterHistorySchema = z.strictObject({
  messages: z.array(
    z.strictObject({
      role: z.literal("assistant"),
      content: z.string(),
      segments,
    }),
  ),
  truncated: z.boolean(),
});

/** Model-facing imports use names; actions and limits come from the host. */
export const turnPolicyModelInputSchema = z.strictObject({
  present: z.array(name).max(32),
  recentSegments: segments,
});
export const turnPolicyModelOutputSchema = z.strictObject({
  actors: z
    .array(
      z.strictObject({
        character: name,
        reason: z.string().max(500).optional(),
        instruction,
      }),
    )
    .max(32),
  ...planFields,
});

export type TurnPolicyRequest = z.infer<typeof turnPolicyRequestSchema>;
export type TurnPolicyInput = z.infer<typeof turnPolicyInputSchema>;
export type TurnPolicyOutput = z.infer<typeof turnPolicyOutputSchema>;
export type CharacterActorInput = z.infer<typeof characterActorInputSchema>;
export type CharacterActorOutput = z.infer<typeof characterActorOutputSchema>;
export type CharacterHistory = z.infer<typeof characterHistorySchema>;

/** Contextual validation precedes budget clamping; invalid plans are never repaired. */
export function validateTurnPolicyOutput(
  input: TurnPolicyInput,
  value: unknown,
): TurnPolicyOutput {
  const present = new Set(input.present.map((actor) => actor.characterId));
  return turnPolicyOutputSchema
    .superRefine((plan, ctx) => {
      const seen = new Set<string>();
      for (const [index, actor] of plan.actors.entries()) {
        if (!present.has(actor.characterId) || seen.has(actor.characterId))
          ctx.addIssue({
            code: "custom",
            path: ["actors", index, "characterId"],
            message: "Actors must be unique members of present",
          });
        seen.add(actor.characterId);
      }
    })
    .parse(value);
}

const jsonSchema = (schema: z.ZodType): Record<string, unknown> =>
  z.toJSONSchema(schema, { target: "draft-7", io: "input" });
export const turnPolicyRequestJsonSchema = () =>
  jsonSchema(turnPolicyRequestSchema);
export const turnPolicyInputJsonSchema = () =>
  jsonSchema(turnPolicyInputSchema);
export const turnPolicyOutputJsonSchema = () =>
  jsonSchema(turnPolicyOutputSchema);
export const characterActorInputJsonSchema = () =>
  jsonSchema(characterActorInputSchema);
export const characterActorOutputJsonSchema = () =>
  jsonSchema(characterActorOutputSchema);
