import { readFileSync } from "node:fs";

import type { PresetMetadata } from "../../../modules/model-gateway/src/index.js";
import type { PersistedPresetRecord } from "../../../modules/storage/src/index.js";

type PresetTier = PresetMetadata["tier"];

interface LegacyPresetSeed {
  id: string;
  name: string;
  provider: string;
  model: string;
  api_base: string;
  tier: PresetTier;
  is_default?: boolean;
  enabled?: boolean;
  scope?: string;
}

interface LegacyPresetCatalog {
  presets: LegacyPresetSeed[];
}

const LEGACY_PRESET_CATALOG_PATH = new URL("../data/llm_presets.json", import.meta.url);
const TEXTUAL_SUPPORTED_MODES = ["text", "object", "stream", "image", "speech", "transcription"] as const;

function readLegacyPresetCatalog(): LegacyPresetCatalog {
  return JSON.parse(readFileSync(LEGACY_PRESET_CATALOG_PATH, "utf8")) as LegacyPresetCatalog;
}

function readNonEmptyEnv(
  env: Record<string, string | undefined>,
  key: string
): string | undefined {
  const value = env[key]?.trim();
  return value && value.length > 0 ? value : undefined;
}

export function buildRuntimePresetBootstrap(input: {
  env: Record<string, string | undefined>;
}): {
  primaryModel: string;
  providerBaseUrl: string;
  providerApiKey?: string;
  runtimePreset: PresetMetadata;
  runtimePresets: PersistedPresetRecord[];
} {
  const env = input.env;
  const catalog = readLegacyPresetCatalog();
  const defaultSeed =
    catalog.presets.find((preset) => preset.is_default) ??
    catalog.presets[0];

  if (!defaultSeed) {
    throw new Error("Runtime preset bootstrap error: no default preset seed is configured.");
  }

  const openRouterSeed = catalog.presets.find((preset) => preset.provider === "openrouter");
  const primaryApiKey =
    readNonEmptyEnv(env, "LIVE_LLM_PRIMARY_API_KEY") ??
    readNonEmptyEnv(env, "OPENAI_COMPATIBLE_API_KEY") ??
    readNonEmptyEnv(env, "DASHSCOPE_API_KEY");
  const hasDashScopeKey = Boolean(readNonEmptyEnv(env, "DASHSCOPE_API_KEY"));
  const providerBaseUrlFallback = hasDashScopeKey
    ? "https://dashscope.aliyuncs.com/compatible-mode/v1"
    : defaultSeed.api_base;
  const primaryModel =
    readNonEmptyEnv(env, "LIVE_LLM_PRIMARY_MODEL") ??
    readNonEmptyEnv(env, "OPENAI_COMPATIBLE_MODEL") ??
    (hasDashScopeKey ? "qwen3.5-flash" : defaultSeed.model);
  const providerBaseUrl = primaryApiKey
    ? (
        readNonEmptyEnv(env, "LIVE_LLM_PRIMARY_BASE_URL") ??
        readNonEmptyEnv(env, "OPENAI_COMPATIBLE_BASE_URL") ??
        readNonEmptyEnv(env, "DASHSCOPE_BASE_URL") ??
        providerBaseUrlFallback
      )
    : "in-memory://demo-provider";

  const fallbackPresetIds: string[] = [];
  const runtimePreset: PresetMetadata = {
    id: defaultSeed.id,
    name: defaultSeed.name,
    provider: defaultSeed.provider,
    model: primaryModel,
    tier: defaultSeed.tier,
    baseUrl: providerBaseUrl,
    supportedModes: [...TEXTUAL_SUPPORTED_MODES],
    enabled: defaultSeed.enabled ?? true,
    isDefault: true,
    scope: defaultSeed.scope ?? "global"
  };
  const runtimePresets: PersistedPresetRecord[] = [
    {
      ...runtimePreset,
      apiKey: primaryApiKey
    }
  ];

  const secondaryModel = readNonEmptyEnv(env, "LIVE_LLM_SECONDARY_MODEL");
  if (secondaryModel && secondaryModel !== primaryModel) {
    const secondaryPresetId = "fast-story";
    fallbackPresetIds.push(secondaryPresetId);
    runtimePresets.push({
      id: secondaryPresetId,
      name: "Fast story",
      provider: defaultSeed.provider,
      model: secondaryModel,
      tier: "small",
      baseUrl: providerBaseUrl,
      supportedModes: [...TEXTUAL_SUPPORTED_MODES],
      enabled: true,
      isDefault: false,
      scope: "global",
      apiKey: primaryApiKey
    });
  }

  const openRouterApiKey = readNonEmptyEnv(env, "OPENROUTER_API_KEY");
  if (openRouterApiKey && openRouterSeed) {
    const configuredOpenRouterModel = readNonEmptyEnv(env, "OPENROUTER_MODEL");
    const openRouterPresetId = configuredOpenRouterModel ? "openrouter-story" : openRouterSeed.id;
    fallbackPresetIds.push(openRouterPresetId);
    runtimePresets.push({
      id: openRouterPresetId,
      name: configuredOpenRouterModel ? "OpenRouter story" : openRouterSeed.name,
      provider: openRouterSeed.provider,
      model: configuredOpenRouterModel ?? openRouterSeed.model,
      tier: openRouterSeed.tier,
      baseUrl: readNonEmptyEnv(env, "OPENROUTER_BASE_URL") ?? openRouterSeed.api_base,
      supportedModes: [...TEXTUAL_SUPPORTED_MODES],
      enabled: openRouterSeed.enabled ?? true,
      isDefault: false,
      scope: openRouterSeed.scope ?? "global",
      apiKey: openRouterApiKey
    });
  }

  if (fallbackPresetIds.length > 0) {
    runtimePreset.fallbackPresetIds = [...fallbackPresetIds];
    runtimePresets[0] = {
      ...runtimePresets[0],
      fallbackPresetIds: [...fallbackPresetIds]
    };
  }

  return {
    primaryModel,
    providerBaseUrl,
    providerApiKey: primaryApiKey,
    runtimePreset,
    runtimePresets
  };
}
