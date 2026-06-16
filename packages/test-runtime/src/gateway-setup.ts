/**
 * Gateway, slot, and model-database setup for the test runtime.
 *
 * Extracted from runner.ts: provides the mock {@link PluginRuntimeGateway},
 * loads provider API keys / model DB from disk, configures slots from an
 * {@link AiConfig}, and assembles live LLM + gateway adapters from llm.toml.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BUNDLED_MODEL_DB_PATH,
  createGateway,
  createModelDatabase,
  createPresetRegistry,
  createProviderRegistry,
  createSlotRegistry,
  fetchWithRetry,
  loadLlmConfig,
  parseLlmConfig,
  setModelDatabase,
  validateBaseUrlForPlugin,
  type AiConfig,
  type ModelSlotConfig,
} from "@covel/ai-provider";
import {
  type PluginRuntimeGateway,
  type PluginRuntimeUtils,
} from "@covel/plugin-loader";
import {
  createGatewayAdapter,
  createPluginRuntimeGateway,
  type LLMAdapter,
} from "@covel/runtime";
import {
  providerApiKeysFromEnv,
  providerIdToApiKeyEnvName,
  readRuntimeEnv,
} from "@covel/shared";
import type { RunRuntimeDebugOptions } from "./types.js";

const DEFAULT_LLM_TOML = `
[covel.story]
provider = "deepseek"
model    = "deepseek-chat"
baseUrl  = "https://api.deepseek.com"
protocol = "openai-chat-v1"
`;

export const PLUGIN_UTILS: PluginRuntimeUtils = {
  validateBaseUrl: validateBaseUrlForPlugin,
  fetchWithRetry,
};

export function makeGateway(
  options: RunRuntimeDebugOptions,
): PluginRuntimeGateway {
  return {
    async generateText(input) {
      return {
        text:
          input.prompt ??
          input.messages?.map((m) => m.content).join("\n") ??
          "",
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
    async generateObject<T = unknown>() {
      return {
        object: { ok: true } as T,
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
    resolveSlot() {
      // Mock harness: return a synthetic slot config so plugins that own
      // their own wire (e.g. openai-image-gen) can be unit-tested without
      // a live llm.toml. Live mode replaces this whole gateway with a
      // real one via createPluginRuntimeGateway().
      return {
        presetId: options.mockPresetId ?? "mock-image",
        provider: "mock",
        protocol: "openai-chat-v1",
        baseUrl: "mock://covel-test-runtime/v1",
        apiKey: "mock-api-key",
        model: "mock-model",
        tag: "image",
        metadata: {},
      };
    },
  };
}

function loadKeysEnvInto(target: NodeJS.ProcessEnv): void {
  const env = readRuntimeEnv(target);
  const covelHome = env.covelHome ?? path.join(os.homedir(), ".covel");
  const file = path.join(covelHome, "keys.env");
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf-8").split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    const envKey = providerIdToApiKeyEnvName(key);
    if (envKey && target[envKey] === undefined) target[envKey] = val;
  }
}

function configureSlots(
  config: AiConfig,
): ReturnType<typeof createSlotRegistry> {
  const presetRegistry = createPresetRegistry({
    profiles: config.profiles,
    presets: config.presets,
  });
  const slotRegistry = createSlotRegistry({ presetRegistry });
  const slots: Record<string, ModelSlotConfig> = {};
  for (const preset of config.presets) {
    if (preset.defaultSlot && preset.enabled) {
      slots[preset.defaultSlot] = {
        slotId: preset.defaultSlot,
        presetId: preset.id,
        tag: preset.tag ?? "text",
      };
    }
  }
  slotRegistry.configure({ slots });
  return slotRegistry;
}

function loadModelDb(): void {
  const env = readRuntimeEnv();
  const candidates = [
    env.modelDbPath,
    env.userConfigDir
      ? path.resolve(env.userConfigDir, "model-db.json")
      : undefined,
    BUNDLED_MODEL_DB_PATH,
  ].filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
  for (const candidate of candidates) {
    try {
      const raw = fs.readFileSync(candidate, "utf-8");
      const data = JSON.parse(raw) as Parameters<typeof createModelDatabase>[0];
      setModelDatabase(createModelDatabase(data));
      return;
    } catch {
      // Try the next candidate.
    }
  }
}

export function makeLiveAdapters(): {
  llm: LLMAdapter;
  gateway: PluginRuntimeGateway;
} {
  loadKeysEnvInto(process.env);
  loadModelDb();

  const env = readRuntimeEnv();
  const covelHome = env.covelHome ?? path.join(os.homedir(), ".covel");
  const llmTomlCandidates = [
    env.llmToml ? path.resolve(env.llmToml) : undefined,
    path.join(covelHome, "llm.toml"),
    path.resolve(process.cwd(), "llm.toml"),
  ].filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );

  let config: AiConfig;
  let loaded: ReturnType<typeof loadLlmConfig> | null = null;
  for (const candidate of llmTomlCandidates) {
    try {
      loaded = loadLlmConfig(candidate);
      if (loaded) break;
    } catch {
      loaded = null;
    }
  }
  config = loaded?.aiConfig ?? parseLlmConfig(DEFAULT_LLM_TOML).aiConfig;

  const providerRegistry = createProviderRegistry({
    providerDefaults: config.providers,
  });
  const presetRegistry = createPresetRegistry({
    profiles: config.profiles,
    presets: config.presets,
  });
  const slotRegistry = configureSlots(config);
  const aiGateway = createGateway({
    providerRegistry,
    presetRegistry,
    slotRegistry,
  });
  const apiKeys = providerApiKeysFromEnv(process.env);
  return {
    llm: createGatewayAdapter(aiGateway, { apiKeys }),
    gateway: createPluginRuntimeGateway(aiGateway, { apiKeys }),
  };
}
