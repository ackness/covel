/**
 * Model resolver — resolves the effective LLM model/slot for a runtime.
 *
 * The `model` field in PLUGIN.md is treated as a **slot name** (e.g., "fast", "default").
 * Resolution looks up that slot name through a chain:
 *
 *   1. API request `modelOverride` — per-turn override, bypasses everything
 *   2. Plugin `llm.toml` [plugin.<slot>] — plugin-local override for the slot name
 *   3. System `llm.toml` [slots.<slot>] — system-level slot (passthrough to gateway)
 *   4. Plugin `llm.toml` [plugin.default] — plugin-local fallback
 *   5. System default slot — undefined, gateway uses its first configured slot
 *
 * Example:
 *   PLUGIN.md has `model: plugin`
 *   Plugin's llm.toml has [plugin.fast] with model="qwen3.5-flash"
 *   System's llm.toml has [slots.fast] with model="qwen3.5-flash-different"
 *   → Uses plugin's version (qwen3.5-flash), NOT system's
 *
 *   If plugin's llm.toml does NOT have [plugin.fast]:
 *   → Falls through to system's "fast" slot
 */

import type { RuntimeManifest } from "@covel/shared";
import type { PluginLlmConfig } from "@covel/plugin-loader";

export interface ModelResolverConfig {
  /** Map of pluginId/runtimeName → PluginLlmConfig (from plugin-level llm.toml files). */
  readonly pluginLlmConfigs: ReadonlyMap<string, PluginLlmConfig>;
}

/**
 * Create a model resolver.
 *
 * The returned function resolves a RuntimeManifest's model slot name
 * to the actual model identifier to pass to the LLM gateway.
 */
export function createModelResolver(
  config: ModelResolverConfig,
): (manifest: RuntimeManifest, apiOverride?: string) => string | undefined {
  const { pluginLlmConfigs } = config;

  return (
    manifest: RuntimeManifest,
    apiOverride?: string,
  ): string | undefined => {
    // 1. API override (highest priority — bypasses everything)
    if (apiOverride) {
      // Even API override goes through plugin-local lookup first
      const pluginResolved = resolveFromPluginConfig(
        manifest.name,
        apiOverride,
        pluginLlmConfigs,
      );
      if (pluginResolved) return pluginResolved;
      // Fall through to system slot (gateway resolves the name)
      return apiOverride;
    }

    // 2. PLUGIN.md model field → treat as slot name, resolve through chain
    if (manifest.model) {
      // 2a. Check plugin llm.toml for [plugin.<slotName>]
      const pluginResolved = resolveFromPluginConfig(
        manifest.name,
        manifest.model,
        pluginLlmConfigs,
      );
      if (pluginResolved) return pluginResolved;

      // 2b. Fall through to system slot (gateway resolves "fast" → system llm.toml [slots.fast])
      return manifest.model;
    }

    // 3. No model in PLUGIN.md → check plugin llm.toml [plugin.default]
    const pluginDefault = resolveFromPluginConfig(
      manifest.name,
      "default",
      pluginLlmConfigs,
    );
    if (pluginDefault) return pluginDefault;

    // 4. System default (undefined → gateway uses its first configured slot)
    return undefined;
  };
}

/**
 * Look up a slot name in a plugin's llm.toml config.
 * Returns the model string if found, undefined otherwise.
 */
function resolveFromPluginConfig(
  runtimeName: string,
  slotName: string,
  pluginLlmConfigs: ReadonlyMap<string, PluginLlmConfig>,
): string | undefined {
  const pluginConfig = pluginLlmConfigs.get(runtimeName);
  if (!pluginConfig) return undefined;

  const slot = pluginConfig.slots[slotName];
  if (slot) return slot.model;

  return undefined;
}
