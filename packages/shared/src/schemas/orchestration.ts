import { z } from "zod";
import {
  CHARACTER_ACTOR_CONTRACT,
  characterActorOutputJsonSchema,
  storySegmentSchema,
} from "@covel/plugin-handlers-utils";

export const turnPolicySelectionSchema = z.strictObject({
  pluginId: z.string().min(1),
  name: z.string().min(1),
});
export const orchestrationSettingsSchema = z.strictObject({
  turnPolicy: turnPolicySelectionSchema.optional(),
  maxActors: z.number().int().min(0).max(16).optional(),
  maxSubagentCalls: z.number().int().min(0).max(64).optional(),
});
export const orchestrationSettingsPatchSchema =
  orchestrationSettingsSchema.extend({
    turnPolicy: turnPolicySelectionSchema.nullable().optional(),
  });
export type OrchestrationSettings = z.infer<typeof orchestrationSettingsSchema>;
export type NormalizedOrchestrationSettings = OrchestrationSettings & {
  maxActors: number;
  maxSubagentCalls: number;
};
export function normalizeOrchestrationSettings(
  value?: unknown,
): NormalizedOrchestrationSettings {
  const settings = orchestrationSettingsSchema.parse(value ?? {});
  return {
    ...settings,
    maxActors: settings.maxActors ?? 4,
    maxSubagentCalls: settings.maxSubagentCalls ?? 16,
  };
}

/** Schema ownership does not make a plugin provider a required kernel extension. */
export const frameworkContractSchemas: Readonly<
  Record<string, Readonly<Record<string, unknown>>>
> = Object.freeze({
  [CHARACTER_ACTOR_CONTRACT]: characterActorOutputJsonSchema(),
});

export interface DelegationSnapshot {
  readonly scopeId: string;
  readonly privateCallIds?: readonly string[];
  readonly concealedCallIds?: readonly string[];
  readonly limits: NormalizedOrchestrationSettings;
  readonly calls: number;
  readonly actorIds: readonly string[];
  readonly historySnapshot?: {
    readonly messages: readonly {
      readonly presentCharacterIds: readonly string[];
      readonly segments: import("@covel/plugin-handlers-utils").CharacterHistory["messages"][number]["segments"];
    }[];
    readonly truncated: boolean;
  };
}

export const delegationSnapshotSchema = z
  .strictObject({
    scopeId: z.string().min(1),
    privateCallIds: z.array(z.string().min(1)).optional(),
    concealedCallIds: z.array(z.string().min(1)).optional(),
    limits: orchestrationSettingsSchema.required({
      maxActors: true,
      maxSubagentCalls: true,
    }),
    calls: z.number().int().min(0).max(64),
    actorIds: z.array(z.string().min(1)).max(16),
    historySnapshot: z
      .strictObject({
        messages: z
          .array(
            z.strictObject({
              presentCharacterIds: z.array(z.string().min(1)),
              segments: z.array(storySegmentSchema.strict()).min(1).max(60),
            }),
          )
          .max(200),
        truncated: z.boolean(),
      })
      .optional(),
  })
  .superRefine((snapshot, ctx) => {
    if (
      snapshot.calls > snapshot.limits.maxSubagentCalls ||
      snapshot.actorIds.length > snapshot.limits.maxActors ||
      snapshot.actorIds.length > snapshot.calls ||
      new Set(snapshot.actorIds).size !== snapshot.actorIds.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Delegation admissions must fit the frozen limits",
      });
  });

export interface OrchestrationResponse {
  readonly settings: NormalizedOrchestrationSettings;
  readonly policies: {
    readonly pluginId: string;
    readonly name: string;
    readonly label: string;
    readonly status: "available" | "paused" | "unavailable";
  }[];
  readonly status: "selected" | "unique" | "missing" | "ambiguous" | "paused";
}
