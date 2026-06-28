import { z } from "zod";
import type { SettingsStoreApi } from "@covel/settings";

const slotConfigEntrySchema = z.object({
  presetId: z.string(),
});

const slotConfigSchema = z.record(z.string(), slotConfigEntrySchema);

const customPresetSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  baseUrl: z.string().optional(),
  model: z.string(),
  protocol: z.string().optional(),
  apiKey: z.string().optional(),
});

const paramOverrideSchema = z.object({
  temperature: z.number().optional(),
  topP: z.number().optional(),
  maxOutputTokens: z.number().optional(),
  frequencyPenalty: z.number().optional(),
  presencePenalty: z.number().optional(),
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
    label: { "zh-CN": "Slot 配置", "en-US": "Slot configuration" },
    description: {
      "zh-CN": "为每个 slot 指定要用的 preset (覆盖 llm.toml 的默认值)",
      "en-US": "Pick a preset for each slot (overrides llm.toml defaults)",
    },
  });

  store.register({
    key: "llm.customPresets",
    schema: z.array(customPresetSchema),
    default: [],
    group: "llm",
    widget: "custom",
    label: { "zh-CN": "自定义 Preset", "en-US": "Custom presets" },
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

  store.register({
    key: "llm.runtimePriority",
    schema: z.record(z.string(), z.number()),
    default: {},
    group: "llm",
    widget: "custom",
    label: {
      "zh-CN": "Runtime 优先级覆盖",
      "en-US": "Runtime priority overrides",
    },
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
