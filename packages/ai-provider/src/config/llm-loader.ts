import { parse as parseToml } from "smol-toml";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { llmConfigSchema, type LlmConfig, type SlotDefinition } from "./llm-schema.js";
import type { AiConfig, ModelProfile, PresetConfig, ProviderDefaults, OperationMode } from "../types.js";
import { resolveCapability, type ManualCapabilityOverride } from "../capability/index.js";

/** Fallback context window when the capability DB does not report one. */
const DEFAULT_EMBED_CONTEXT_WINDOW = 8_192;

/**
 * Load llm.toml from disk, validate, and convert to internal AiConfig format.
 *
 * Uses synchronous I/O intentionally — this function is called once at server
 * startup before any request handling begins. Do not use in request paths.
 *
 * Returns null if the file does not exist (caller should fall back to defaults).
 * Throws on parse/validation errors.
 */
export function loadLlmConfig(filePath: string): { llmConfig: LlmConfig; aiConfig: AiConfig } | null {
  const absolutePath = resolve(filePath);
  try {
    if (!statSync(absolutePath).isFile()) return null;
  } catch {
    return null;
  }

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
  const profiles: ModelProfile[] = [];

  for (const [slotName, _def] of Object.entries(llm.covel)) {
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

    // Derive tag: explicit > inferred from output modalities
    const tag = def.tag ?? inferTag(capability.output);

    const presetId = `slot-${slotName}`;
    const fallbackIds = def.fallback ? [`slot-${def.fallback}`] : [];

    // First slot in llm.toml is the default — mark it as isDefault
    const isFirstSlot = presets.length === 0;

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
      isDefault: isFirstSlot,
      fallbackPresetIds: fallbackIds.length > 0 ? fallbackIds : undefined,
      capability,
      tag,
      ...(def.imageApi !== undefined ? { imageApi: def.imageApi } : {}),
      ...(def.embeddingFormat !== undefined ? { embeddingFormat: def.embeddingFormat } : {}),
    });

    // Synthesize the "embed-default" profile on the first slot that declares
    // an embedding model. Later embed slots remain addressable via their own
    // preset ID but do not override the default.
    const isEmbedSlot = supportedModes.includes("embed");
    const hasEmbedDefault = profiles.some((p) => p.id === "embed-default");
    if (isEmbedSlot && !hasEmbedDefault) {
      profiles.push({
        id: "embed-default",
        tier: "embed-default",
        provider: def.provider,
        model: def.model,
        contextWindow: capability.contextWindow ?? DEFAULT_EMBED_CONTEXT_WINDOW,
        latencyClass: "medium",
        costClass: "medium",
        supportedModes: ["embed"],
      });
    }
  }

  return { providers, profiles, presets };
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

/**
 * Infer slot tag from output modalities.
 * If any output is "image", tag is "image". Otherwise "text".
 */
function inferTag(outputModalities: readonly string[]): string {
  if (outputModalities.includes("image")) return "image";
  return "text";
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
      // Split off inline comment — only interpolate the active portion.
      // TOML inline comments start with # outside of quoted strings.
      // Simplified: find the first # that is not inside a quoted value.
      const commentIdx = findInlineCommentIndex(line);
      const active = commentIdx >= 0 ? line.slice(0, commentIdx) : line;
      const comment = commentIdx >= 0 ? line.slice(commentIdx) : "";
      const replaced = active.replace(
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
      return replaced + comment;
    })
    .join("\n");
  if (missing.length > 0) {
    throw new Error(`llm.toml: unresolved environment variables: ${missing.join(", ")}`);
  }
  return result;
}

/**
 * Find the index of an inline `#` comment in a TOML line, skipping `#` inside
 * single-quoted or double-quoted strings. Returns -1 if no comment is found.
 */
function findInlineCommentIndex(line: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === "#" && !inSingle && !inDouble) {
      return i;
    }
  }
  return -1;
}
