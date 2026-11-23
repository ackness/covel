import { z } from "zod";

export const DEFAULT_PROMPT_SEGMENT_BUDGET = 2_000;
export const promptPrioritySchema = z.enum(["high", "normal", "low"]);

export const PROTECTED_PROMPT_BLOCKS = [
  "framework.preamble",
  "world.lore",
  "plugin.instructions",
  "player.message",
  "history",
] as const;

export type ProtectedPromptBlock = (typeof PROTECTED_PROMPT_BLOCKS)[number];

export const SUPPRESSIBLE_PROMPT_BLOCKS = [
  "world.info.before",
  "world.info.after",
  "session.events",
  "operation.notices",
] as const;

export type SuppressiblePromptBlock =
  (typeof SUPPRESSIBLE_PROMPT_BLOCKS)[number];

export const promptFactKeySchema = z
  .string()
  .max(128)
  .regex(/^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+$/, {
    message:
      "Fact keys must be dot-separated lowercase identifiers (e.g. combat.active)",
  });

export const promptFactValueSchema = z.union([
  z.boolean(),
  z.string().max(128),
  z.number().finite(),
]);

export type PromptFactValue = z.infer<typeof promptFactValueSchema>;

export const promptWhenClauseSchema = z.strictObject({
  fact: promptFactKeySchema.describe(
    "Dot-separated fact key in the cross-plugin Facts Registry.",
  ),
  equals: promptFactValueSchema
    .describe("Match when the fact value equals this scalar.")
    .optional(),
  notEquals: promptFactValueSchema
    .describe("Match when the fact value is not equal to this scalar.")
    .optional(),
  in: z
    .array(promptFactValueSchema)
    .min(1)
    .max(32)
    .describe("Match when the fact value is contained in this list.")
    .optional(),
  exists: z
    .boolean()
    .describe("Match whether the fact key is present (true) or absent (false).")
    .optional(),
});

export type PromptWhenClause = z.infer<typeof promptWhenClauseSchema>;

export const promptWhenSchema = z.union([
  promptWhenClauseSchema,
  z.strictObject({
    all: z
      .array(promptWhenClauseSchema)
      .min(1)
      .max(32)
      .describe("Match when every predicate clause evaluates to true."),
  }),
  z.strictObject({
    any: z
      .array(promptWhenClauseSchema)
      .min(1)
      .max(32)
      .describe("Match when at least one predicate clause evaluates to true."),
  }),
]);

export type PromptWhen = z.infer<typeof promptWhenSchema>;

export type PromptSegmentGovernanceDiagnostic =
  | {
      readonly kind: "truncated";
      readonly pluginId: string;
      readonly segmentId: string;
      readonly budget: number;
      readonly originalTokens: number;
      readonly finalTokens: number;
    }
  | {
      readonly kind: "protected-suppress-ignored";
      readonly pluginId: string;
      readonly segmentId: string;
      readonly targetId: string;
    };
