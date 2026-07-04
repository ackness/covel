/**
 * Plugin-level LLM config — reads optional llm.toml from plugin directory.
 *
 * Supports:
 *   [plugin.default]
 *   provider = "dashscope"
 *   model    = "qwen3.5-flash"
 *   baseUrl  = "https://dashscope.aliyuncs.com/compatible-mode/v1"
 *   protocol = "openai-chat-v1"
 *
 * The `plugin.default` section defines the plugin's preferred default model.
 * This has medium priority: API override > plugin llm.toml > PLUGIN.md model field.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";

export interface PluginLlmSlot {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl?: string;
  readonly protocol?: string;
}

export interface PluginLlmConfig {
  /** Default model slot for this plugin. */
  readonly defaultSlot?: PluginLlmSlot;
  /** Named slots (e.g., plugin.fast, plugin.image). */
  readonly slots: Readonly<Record<string, PluginLlmSlot>>;
}

/**
 * Load plugin-level llm.toml from a plugin directory.
 * Returns null if no llm.toml exists.
 */
export async function loadPluginLlmConfig(
  pluginDir: string,
): Promise<PluginLlmConfig | null> {
  const configPath = path.join(pluginDir, "llm.toml");

  let content: string;
  try {
    content = await fs.readFile(configPath, "utf-8");
  } catch {
    return null;
  }

  return parsePluginLlmToml(content);
}

/**
 * Parse plugin llm.toml content.
 *
 * Expected format:
 *   [plugin.default]
 *   provider = "dashscope"
 *   model = "qwen3.5-flash"
 *   baseUrl = "..."
 *   protocol = "openai-chat-v1"
 *
 *   [plugin.fast]
 *   provider = "..."
 *   model = "..."
 */
export function parsePluginLlmToml(content: string): PluginLlmConfig {
  let root: Record<string, unknown>;
  try {
    root = parseToml(content) as Record<string, unknown>;
  } catch (error: unknown) {
    // Malformed llm.toml must not crash plugin loading — skip it with a warning.
    console.warn(
      `[plugin-loader] ignoring malformed plugin llm.toml: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { slots: {} };
  }

  const pluginTable = root.plugin;
  if (!pluginTable || typeof pluginTable !== "object") {
    return { slots: {} };
  }

  const slots: Record<string, PluginLlmSlot> = {};
  for (const [name, raw] of Object.entries(
    pluginTable as Record<string, unknown>,
  )) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const { provider, model, baseUrl, protocol } = entry;
    // A slot only counts when both provider and model are present.
    if (typeof provider !== "string" || typeof model !== "string") continue;
    slots[name] = {
      provider,
      model,
      baseUrl: typeof baseUrl === "string" ? baseUrl : undefined,
      protocol: typeof protocol === "string" ? protocol : undefined,
    };
  }

  return {
    defaultSlot: slots["default"],
    slots,
  };
}
