import { parse as parseToml, TomlError } from "smol-toml";
import { z } from "zod";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import {
  llmConfigSchema,
  type LlmConfig,
  type SlotDefinition,
} from "./llm-schema.js";
import type {
  AiConfig,
  ModelProfile,
  PresetConfig,
  ProviderDefaults,
  OperationMode,
} from "../types.js";
import {
  resolveCapability,
  type ManualCapabilityOverride,
} from "../capability/index.js";
import { modelOutputTag, readEnvString } from "@covel/shared";

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
export function loadLlmConfig(
  filePath: string,
): { llmConfig: LlmConfig; aiConfig: AiConfig } | null {
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
export function parseLlmConfig(toml: string): {
  llmConfig: LlmConfig;
  aiConfig: AiConfig;
} {
  const { text, substituted } = interpolateEnv(toml);
  // The text being parsed holds the values of environment variables (API
  // keys, database URLs). Parse and validation errors reach logs, the
  // Settings page and the raw-config API, so none of them may quote it.
  let parsed: unknown;
  try {
    parsed = parseToml(text);
  } catch (err) {
    if (err instanceof TomlError) {
      // smol-toml appends a code block cut from the interpolated text; the
      // short reason before it is a fixed phrase.
      const reason = err.message.split("\n")[0] ?? "Invalid TOML document";
      throw new Error(
        `llm.toml: ${reason} (line ${err.line}, column ${err.column})`,
      );
    }
    throw new Error("llm.toml: could not be parsed");
  }
  const checked = llmConfigSchema.safeParse(parsed);
  if (!checked.success) {
    // A substituted value can still appear as a key name in an issue.
    throw new Error(
      redactSubstituted(
        `llm.toml: ${z.prettifyError(checked.error)}`,
        substituted,
      ),
    );
  }
  const llmConfig = checked.data;
  const aiConfig = convertToAiConfig(llmConfig);
  return { llmConfig, aiConfig };
}

/** Put `${NAME}` back in place of every environment value that was substituted. */
function redactSubstituted(
  message: string,
  substituted: Map<string, string>,
): string {
  let out = message;
  for (const [name, value] of substituted) {
    if (value.length > 0) out = out.split(value).join("${" + name + "}");
  }
  return out;
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
      (def.input ??
      def.output ??
      def.features ??
      def.contextWindow ??
      def.maxOutputTokens ??
      def.pricing)
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
    const capability = resolveCapability(
      def.model,
      def.provider,
      def.protocol,
      manual,
    );

    // Derive supportedModes from capability output modalities
    const supportedModes = deriveSupportedModes(capability.output);

    // Derive tag: explicit > inferred from output modalities
    const tag = def.tag ?? modelOutputTag(capability.output);

    const presetId = `slot-${slotName}`;
    const fallbackIds = def.fallback ? [`slot-${def.fallback}`] : [];

    // First slot in llm.toml is the default — mark it as isDefault
    const isFirstSlot = presets.length === 0;

    const providerRequestMetadata = buildProviderRequestMetadata(def);

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
      ...(def.providerOptions ? { providerOptions: def.providerOptions } : {}),
      ...(def.embeddingFormat !== undefined
        ? { embeddingFormat: def.embeddingFormat }
        : {}),
      ...(providerRequestMetadata !== undefined
        ? { providerRequestMetadata }
        : {}),
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
 * - audio output → speech, music (the slot's tag says which it is for)
 * - embedding output → embed
 * - evaluation output → evaluate
 */
function deriveSupportedModes(
  outputModalities: readonly string[],
): OperationMode[] {
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
        modes.push("speech", "music");
        break;
      case "evaluation":
        modes.push("evaluate");
        break;
      case "embedding":
        modes.push("embed");
        break;
    }
  }
  return modes.length > 0 ? modes : ["text", "object", "stream"];
}

/**
 * Build the preset's slot-wide request metadata. The portable
 * `reasoningEffort` is stored as a model default under `parameterOverrides`,
 * the same shape a model configured in Settings carries, so both sources
 * follow one precedence and the Settings UI shows the inherited value.
 * Freeform `providerRequestMetadata` keys pass through for provider
 * extensions without a dedicated field.
 *
 * Per-call metadata at request time beats these slot-wide defaults.
 */
function buildProviderRequestMetadata(
  def: SlotDefinition,
): Record<string, unknown> | undefined {
  const merged: Record<string, unknown> = {
    ...def.providerRequestMetadata,
  };
  if (def.reasoningEffort !== undefined)
    merged.parameterOverrides = {
      ...(merged.parameterOverrides as Record<string, unknown> | undefined),
      reasoningEffort: def.reasoningEffort,
    };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function formatPresetName(slotName: string, def: SlotDefinition): string {
  const label = slotName.charAt(0).toUpperCase() + slotName.slice(1);
  const providerLabel =
    def.provider.charAt(0).toUpperCase() + def.provider.slice(1);
  return `${label} — ${providerLabel} ${def.model}`;
}

/**
 * Replace `${VAR_NAME}` with values from process.env.
 * Only processes non-comment lines (TOML comments start with #).
 * Throws if `${...}` patterns are found in active lines but the variable is undefined.
 */
function interpolateEnv(input: string): {
  text: string;
  substituted: Map<string, string>;
} {
  const missing: string[] = [];
  const substituted = new Map<string, string>();
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
          const value = readEnvString(varName);
          if (value === undefined) {
            missing.push(varName);
            return match;
          }
          substituted.set(varName, value);
          return value;
        },
      );
      return replaced + comment;
    })
    .join("\n");
  if (missing.length > 0) {
    throw new Error(
      `llm.toml: unresolved environment variables: ${missing.join(", ")}`,
    );
  }
  return { text: result, substituted };
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
