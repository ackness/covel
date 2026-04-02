import { parse as parseToml } from "smol-toml";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { llmConfigSchema, type LlmConfig, type SlotDefinition } from "./llm-schema.js";
import type { AiConfig, PresetConfig, ProviderDefaults, OperationMode } from "../types.js";
import { resolveCapability, type ManualCapabilityOverride } from "../capability/index.js";

/**
 * Load llm.toml from disk, validate, and convert to internal AiConfig format.
 *
 * Returns null if the file does not exist (caller should fall back to defaults).
 * Throws on parse/validation errors.
 */
export function loadLlmConfig(filePath: string): { llmConfig: LlmConfig; aiConfig: AiConfig } | null {
  const absolutePath = resolve(filePath);
  if (!existsSync(absolutePath)) return null;

  let raw: string;
  try {
    raw = readFileSync(absolutePath, "utf-8");
  } catch (err) {
    throw new Error(
      `llm.toml: failed to read "${absolutePath}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return parseLlmConfig(raw);
}

/**
 * Parse an llm.toml string, validate, and convert to internal AiConfig.
 */
export function parseLlmConfig(toml: string): { llmConfig: LlmConfig; aiConfig: AiConfig } {
  const interpolated = interpolateEnv(toml);
  const parsed = parseToml(interpolated);
  const llmConfig = llmConfigSchema.parse(parsed);
  const aiConfig = convertToAiConfig(llmConfig);
  return { llmConfig, aiConfig };
}

/**
 * Convert slot-centric LlmConfig → internal AiConfig (providers + presets).
 *
 * Each slot becomes:
 * - A provider entry (deduplicated by provider name)
 * - A preset with id = "slot-{slotName}"
 * - Slot mapping: slotName → preset id
 * - Auto-inferred ModelCapability (from known DB, with manual override)
 */
function convertToAiConfig(llm: LlmConfig): AiConfig {
  const providers: Record<string, ProviderDefaults> = {};
  const presets: PresetConfig[] = [];
  const hasHeavy = "heavy" in llm.slots;

  for (const [slotName, _def] of Object.entries(llm.slots)) {
    const def = _def as SlotDefinition;
    // Register provider (first occurrence wins for baseUrl/protocol)
    if (!providers[def.provider]) {
      providers[def.provider] = {
        baseUrl: def.baseUrl,
        protocol: def.protocol,
      };
    }

    // Build manual override from llm.toml optional fields
    const manual: ManualCapabilityOverride | undefined =
      (def.input ?? def.output ?? def.features ?? def.contextWindow ?? def.maxOutputTokens ?? def.pricing)
        ? {
            input: def.input,
            output: def.output,
            features: def.features,
            contextWindow: def.contextWindow,
            maxOutputTokens: def.maxOutputTokens,
            pricing: def.pricing,
          }
        : undefined;

    // Resolve capability: manual > known DB > protocol defaults
    const capability = resolveCapability(def.model, def.provider, def.protocol, manual);

    // Derive supportedModes from capability output modalities
    const supportedModes = deriveSupportedModes(capability.output);

    const presetId = `slot-${slotName}`;
    const fallbackIds = def.fallback ? [`slot-${def.fallback}`] : [];

    presets.push({
      id: presetId,
      name: formatPresetName(slotName, def),
      provider: def.provider,
      protocol: def.protocol,
      model: def.model,
      baseUrl: def.baseUrl,
      tier: "medium",
      defaultSlot: slotName,
      supportedModes,
      enabled: true,
      isDefault: slotName === "heavy" || (!hasHeavy && presets.length === 0),
      fallbackPresetIds: fallbackIds.length > 0 ? fallbackIds : undefined,
      capability,
    });
  }

  return { providers, profiles: [], presets };
}

/**
 * Derive OperationMode[] from output modalities.
 *
 * - text output → text, object, stream
 * - image output → image
 * - audio output → speech
 * - embedding output → embed
 */
function deriveSupportedModes(outputModalities: readonly string[]): OperationMode[] {
  const modes: OperationMode[] = [];
  for (const mod of outputModalities) {
    switch (mod) {
      case "text":
        modes.push("text", "object", "stream");
        break;
      case "image":
        modes.push("image");
        break;
      case "audio":
        modes.push("speech");
        break;
      case "embedding":
        modes.push("embed");
        break;
    }
  }
  return modes.length > 0 ? modes : ["text", "object", "stream"];
}

function formatPresetName(slotName: string, def: SlotDefinition): string {
  const label = slotName.charAt(0).toUpperCase() + slotName.slice(1);
  const providerLabel = def.provider.charAt(0).toUpperCase() + def.provider.slice(1);
  return `${label} — ${providerLabel} ${def.model}`;
}

/**
 * Replace `${VAR_NAME}` with values from process.env.
 * Only processes non-comment lines (TOML comments start with #).
 * Throws if `${...}` patterns are found in active lines but the variable is undefined.
 */
function interpolateEnv(input: string): string {
  const missing: string[] = [];
  const result = input
    .split("\n")
    .map((line) => {
      // Skip comment lines
      if (line.trimStart().startsWith("#")) return line;
      return line.replace(
        /\$\{([A-Za-z_][A-Za-z0-9_]*)}/g,
        (match, varName: string) => {
          const value = process.env[varName];
          if (value === undefined) {
            missing.push(varName);
            return match;
          }
          return value;
        },
      );
    })
    .join("\n");
  if (missing.length > 0) {
    throw new Error(`llm.toml: unresolved environment variables: ${missing.join(", ")}`);
  }
  return result;
}
