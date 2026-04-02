import { Hono } from "hono";
import type { LlmConfig, PresetConfig, ModelCapability } from "@covel/ai-provider";

/**
 * GET /api/llm-config
 *
 * Expose the parsed llm.toml configuration to the frontend so it can
 * display the configured slots, auto-derive which API keys are needed,
 * and show model capability tags (modalities, features, limits, pricing).
 *
 * Response format:
 * ```json
 * {
 *   "configured": true,
 *   "slots": {
 *     "main": {
 *       "provider": "deepseek",
 *       "model": "deepseek-chat",
 *       "protocol": "openai-chat-v1",
 *       "capability": {
 *         "input": ["text"],
 *         "output": ["text"],
 *         "features": ["function_calling", "streaming"],
 *         "contextWindow": 131072,
 *         "maxOutputTokens": 8192,
 *         "pricing": { "inputPerMToken": 0.27, "outputPerMToken": 1.1 }
 *       }
 *     }
 *   },
 *   "providers": ["deepseek", "dashscope"]
 * }
 * ```
 *
 * When no llm.toml is present (legacy mode), returns `{ configured: false }`.
 */
export function createLlmConfigRoute(
  llmConfig: LlmConfig | null,
  presets?: PresetConfig[],
) {
  const route = new Hono();

  // Build a preset lookup for capability data
  const presetMap = new Map<string, PresetConfig>();
  if (presets) {
    for (const p of presets) presetMap.set(p.id, p);
  }

  route.get("/", (c) => {
    if (!llmConfig) {
      return c.json({ configured: false, slots: {}, providers: [] });
    }

    const slots: Record<string, {
      provider: string;
      model: string;
      protocol: string;
      fallback?: string;
      capability?: ModelCapability;
    }> = {};

    const providerSet = new Set<string>();

    for (const [slotId, def] of Object.entries(llmConfig.slots)) {
      // Look up the generated preset for this slot to get capability
      const preset = presetMap.get(`slot-${slotId}`);

      slots[slotId] = {
        provider: def.provider,
        model: def.model,
        protocol: def.protocol,
        ...(def.fallback ? { fallback: def.fallback } : {}),
        ...(preset?.capability ? { capability: preset.capability } : {}),
      };
      providerSet.add(def.provider);
    }

    return c.json({
      configured: true,
      slots,
      providers: Array.from(providerSet),
    });
  });

  return route;
}
