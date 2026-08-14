import { z } from "zod";
import type { SettingsStoreApi } from "@covel/settings";
import { REASONING_EFFORT_VALUES } from "@/services/api/reasoning-effort.js";

const slotConfigEntrySchema = z.union([
  z.object({ presetId: z.string().min(1) }),
  z.object({ modelRef: z.string().min(1) }),
]);

const slotConfigSchema = z.record(z.string(), slotConfigEntrySchema);
const providerPriceMultipliersSchema = z.record(
  z.string(),
  z.number().positive(),
);

const customPresetSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  baseUrl: z.string().optional(),
  model: z.string(),
  protocol: z.string().optional(),
  apiKey: z.string().optional(),
});

const providerModelProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  baseUrl: z.string(),
  protocol: z.string().optional(),
  models: z.array(
    z.object({
      ref: z.string().min(1),
      modelId: z.string().min(1),
      name: z.string().optional(),
    }),
  ),
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
    label: { "zh-CN": "用途分配", "en-US": "Model role assignments" },
    description: {
      "zh-CN": "为每种模型用途选择服务商和模型",
      "en-US": "Choose a provider and model for each model role",
    },
  });

  store.register({
    key: "llm.providers",
    schema: z.array(providerModelProfileSchema),
    default: [],
    group: "llm",
    widget: "custom",
    label: { "zh-CN": "服务商与模型", "en-US": "Providers and models" },
  });

  store.register({
    key: "llm.providerPriceMultipliers",
    schema: providerPriceMultipliersSchema,
    default: {},
    group: "llm",
    widget: "custom",
    label: { "zh-CN": "服务商价格倍率", "en-US": "Provider price multipliers" },
  });

  store.register({
    key: "llm.customPresets",
    schema: z.array(customPresetSchema),
    default: [],
    group: "llm",
    widget: "custom",
    label: { "zh-CN": "旧版模型方案", "en-US": "Legacy model plans" },
  });

  store.register({
    key: "llm.paramOverrides",
    schema: z.record(z.string(), paramOverrideSchema),
    default: {},
    group: "llm",
    widget: "custom",
    label: { "zh-CN": "参数覆盖", "en-US": "Parameter overrides" },
  });

  store.register({
    key: "llm.capabilityOverrides",
    schema: z.record(z.string(), capabilityOverrideSchema),
    default: {},
    group: "llm",
    widget: "custom",
    label: { "zh-CN": "能力覆盖", "en-US": "Capability overrides" },
  });

  // Prep-phase runtime bindings. Keyed by worldId; transient — the real
  // session's `runtimeModelOverrides` is authoritative once created.
  store.register({
    key: "llm.prepRuntimeBindings",
    schema: z.record(z.string(), z.record(z.string(), z.string())),
    default: {},
    group: "llm",
    widget: "custom",
    label: {
      "zh-CN": "准备阶段 Runtime 绑定",
      "en-US": "Prep-phase runtime bindings",
    },
  });
}
