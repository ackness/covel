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
import matter from "gray-matter";

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
	// Simple TOML parser for the subset we need (key = "value" under [section.name])
	const slots: Record<string, PluginLlmSlot> = {};
	let currentSection: string | null = null;
	const currentSlot: Record<string, string> = {};

	function flushSlot() {
		if (currentSection && currentSlot.provider && currentSlot.model) {
			slots[currentSection] = {
				provider: currentSlot.provider,
				model: currentSlot.model,
				baseUrl: currentSlot.baseUrl,
				protocol: currentSlot.protocol,
			};
		}
		// Reset
		for (const key of Object.keys(currentSlot)) {
			delete currentSlot[key];
		}
	}

	for (const line of content.split("\n")) {
		const trimmed = line.trim();

		// Skip comments and empty lines
		if (trimmed === "" || trimmed.startsWith("#")) continue;

		// Section header: [plugin.default]
		const sectionMatch = trimmed.match(/^\[plugin\.(\w[\w-]*)\]$/);
		if (sectionMatch) {
			flushSlot();
			currentSection = sectionMatch[1];
			continue;
		}

		// Key-value pair: key = "value" or key = value
		const kvMatch = trimmed.match(/^(\w+)\s*=\s*"?([^"]*)"?\s*$/);
		if (kvMatch && currentSection) {
			currentSlot[kvMatch[1]] = kvMatch[2];
		}
	}
	flushSlot();

	return {
		defaultSlot: slots["default"],
		slots,
	};
}
