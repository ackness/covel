import { z } from "zod";
import type { SettingsStoreApi } from "@covel/settings";
import { providerKeyToId } from "@covel/shared";
import { REASONING_EFFORT_VALUES } from "@/services/api/reasoning-effort.js";

const slotConfigEntrySchema = z.union([
  z.strictObject({ modelRef: z.string().trim().min(1) }),
  z.strictObject({ presetId: z.string().min(1) }),
]);

const slotConfigSchema = z.record(z.string(), slotConfigEntrySchema);
const providerPriceMultipliersSchema = z.record(
  z.string(),
  z.number().positive(),
);

const providerModelProfileSchema = z.object({
  id: z
    .string()
    .transform((id) => providerKeyToId(id) ?? id.trim())
    .pipe(z.string().min(1)),
  name: z.string(),
  provider: z.string().optional(),
  baseUrl: z.string(),
  protocol: z.string().optional(),
  models: z.array(
    z.object({
      ref: z.string().trim().min(1),
      modelId: z.string().min(1),
      reasoningEffort: z.enum(REASONING_EFFORT_VALUES).optional(),
      name: z.string().optional(),
    }),
  ),
});

/** Connection identities and model references each have one owner. */
export const providerModelProfilesSchema = z
  .array(providerModelProfileSchema)
  .superRefine((profiles, context) => {
    const providerIds = new Set<string>();
    const modelRefs = new Set<string>();
    profiles.forEach((profile, profileIndex) => {
      if (providerIds.has(profile.id)) {
        context.addIssue({
          code: "custom",
          path: [profileIndex, "id"],
          message: "Provider connection IDs must be unique",
        });
      }
      providerIds.add(profile.id);
      profile.models.forEach((model, modelIndex) => {
        if (modelRefs.has(model.ref)) {
          context.addIssue({
            code: "custom",
            path: [profileIndex, "models", modelIndex, "ref"],
            message: "Model references must be unique across all connections",
          });
        }
        modelRefs.add(model.ref);
      });
    });
  });

const paramOverrideSchema = z.object({
  temperature: z.number().optional(),
  topP: z.number().optional(),
  maxOutputTokens: z.number().optional(),
  frequencyPenalty: z.number().optional(),
  presencePenalty: z.number().optional(),
  reasoningEffort: z.enum(REASONING_EFFORT_VALUES).optional(),
});

const capabilityOverrideSchema = z.object({
  input: z.array(z.string()).optional(),
  output: z.array(z.string()).optional(),
  features: z.array(z.string()).optional(),
  contextWindow: z.number().optional(),
  maxOutputTokens: z.number().optional(),
  pricing: z
    .object({
      inputPerMToken: z.number().optional(),
      outputPerMToken: z.number().optional(),
      perImage: z.number().optional(),
    })
    .optional(),
});

/**
 * LLM routing preferences. Large opaque objects that drive slot selection,
 * parameter overrides, and model-capability overrides. The Settings UI for
 * these uses purpose-built panels (not the generic widget dispatcher).
 */
export function registerLlmSettings(store: SettingsStoreApi): void {
  store.register({
    key: "llm.slotConfig",
    schema: slotConfigSchema,
    default: {},
    group: "llm",
    widget: "custom",
    label: "Model role assignments",
    description: "Choose a provider and model for each model role",
  });

  store.register({
    key: "llm.providers",
    schema: providerModelProfilesSchema,
    default: [],
    group: "llm",
    widget: "custom",
    label: "Providers and models",
  });

  store.register({
    key: "llm.providerPriceMultipliers",
    schema: providerPriceMultipliersSchema,
    default: {},
    group: "llm",
    widget: "custom",
    label: "Provider price multipliers",
  });

  store.register({
    key: "llm.paramOverrides",
    schema: z.record(z.string(), paramOverrideSchema),
    default: {},
    group: "llm",
    widget: "custom",
    label: "Parameter overrides",
  });

  store.register({
    key: "llm.capabilityOverrides",
    schema: z.record(z.string(), capabilityOverrideSchema),
    default: {},
    group: "llm",
    widget: "custom",
    label: "Capability overrides",
  });

  // Prep-phase runtime bindings. Keyed by worldId; transient — the real
  // session's `runtimeModelOverrides` is authoritative once created.
  store.register({
    key: "llm.prepRuntimeBindings",
    schema: z.record(z.string(), z.record(z.string(), z.string())),
    default: {},
    group: "llm",
    widget: "custom",
    label: "Prep-phase runtime bindings",
  });
}
