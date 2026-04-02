import { resolve } from "node:path";
import {
  loadAiConfig,
  createProviderRegistry,
  createPresetRegistry,
  createSlotRegistry,
  createGateway,
} from "@covel/ai-provider";
import type { SlotRegistry } from "@covel/ai-provider";
import { createRuntimeExecutor } from "@covel/runtime";

/**
 * Initialize AI provider stack from TOML config.
 * Called once at server startup after dotenv is loaded.
 */
export function createAiStack(): AiStack {
  // Ensure provider base URLs have defaults
  process.env.DEEPSEEK_BASE_URL ??= "https://api.deepseek.com";
  process.env.DASHSCOPE_BASE_URL ??= "https://dashscope.aliyuncs.com/compatible-mode/v1";

  const config = loadAiConfig(
    resolve(import.meta.dirname, "../../../packages/ai-provider/presets/default.toml")
  );

  const providerRegistry = createProviderRegistry({
    providerDefaults: config.providers,
  });

  const presetRegistry = createPresetRegistry({
    profiles: config.profiles,
    presets: config.presets,
  });

  const slotRegistry = createSlotRegistry({ presetRegistry });

  // Build default slot map from preset defaultSlot hints
  const defaultPreset = config.presets.find((p) => p.isDefault && p.enabled);
  if (defaultPreset) {
    const slots: Record<string, { slotId: string; presetId: string }> = {};

    // Map presets that declare a defaultSlot
    for (const preset of config.presets) {
      if (preset.defaultSlot && preset.enabled) {
        slots[preset.defaultSlot] = {
          slotId: preset.defaultSlot,
          presetId: preset.id,
        };
      }
    }

    // Ensure "heavy" slot always exists (falls back to default preset)
    if (!slots["heavy"]) {
      slots["heavy"] = { slotId: "heavy", presetId: defaultPreset.id };
    }

    slotRegistry.configure({ slots, defaultSlot: "heavy" });
  }

  const gateway = createGateway({ providerRegistry, presetRegistry, slotRegistry });
  const executor = createRuntimeExecutor(gateway);

  return {
    config,
    providerRegistry,
    presetRegistry,
    slotRegistry,
    gateway,
    executor,
  };
}

export interface AiStack {
  config: ReturnType<typeof loadAiConfig>;
  providerRegistry: ReturnType<typeof createProviderRegistry>;
  presetRegistry: ReturnType<typeof createPresetRegistry>;
  slotRegistry: SlotRegistry;
  gateway: ReturnType<typeof createGateway>;
  executor: ReturnType<typeof createRuntimeExecutor>;
}
