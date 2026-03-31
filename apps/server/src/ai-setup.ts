import { resolve } from "node:path";
import {
  loadAiConfig,
  createProviderRegistry,
  createPresetRegistry,
  createGateway,
} from "@covel/ai-provider";
import { createRuntimeExecutor } from "@covel/runtime";

/**
 * Initialize AI provider stack from TOML config.
 * Called once at server startup after dotenv is loaded.
 */
export function createAiStack() {
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

  const gateway = createGateway({ providerRegistry, presetRegistry });
  const executor = createRuntimeExecutor(gateway);

  return {
    config,
    providerRegistry,
    presetRegistry,
    gateway,
    executor,
  };
}

export type AiStack = ReturnType<typeof createAiStack>;
