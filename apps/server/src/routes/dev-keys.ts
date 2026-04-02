import { Hono } from "hono";
import type { LlmConfig } from "@covel/ai-provider";

/**
 * Expose server-configured provider keys to the frontend for auto-fill.
 *
 * Key resolution: provider name → {PROVIDER_UPPER}_API_KEY env var.
 *
 * When llm.toml is present, only returns keys for providers defined in slots.
 * When no llm.toml, falls back to a static list of well-known providers.
 *
 * Returns: `{ keys: { "deepseek": "sk-...", "dashscope": "sk-..." } }`
 */

/** Well-known provider → env var mappings (fallback when no llm.toml). */
const FALLBACK_PROVIDERS: ReadonlyArray<[provider: string, envVar: string]> = [
  ["deepseek", "DEEPSEEK_API_KEY"],
  ["dashscope", "DASHSCOPE_API_KEY"],
  ["openai", "OPENAI_API_KEY"],
  ["anthropic", "ANTHROPIC_API_KEY"],
  ["google", "GOOGLE_API_KEY"],
];

/** Derive env var name from provider id: "deepseek" → "DEEPSEEK_API_KEY". */
function providerToEnvVar(provider: string): string {
  return `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
}

export function createDevKeysRoute(llmConfig?: LlmConfig | null) {
  const route = new Hono();

  route.get("/", (c) => {
    const keys: Record<string, string> = {};

    if (llmConfig) {
      // Derive providers from llm.toml slots
      const providers = new Set<string>();
      for (const def of Object.values(llmConfig.slots)) {
        providers.add(def.provider);
      }
      for (const provider of providers) {
        const envVar = providerToEnvVar(provider);
        const value = process.env[envVar];
        if (value) {
          keys[provider] = value;
        }
      }
    } else {
      // Fallback: static well-known providers
      for (const [provider, envVar] of FALLBACK_PROVIDERS) {
        const value = process.env[envVar];
        if (value) {
          keys[provider] = value;
        }
      }
    }

    return c.json({ keys });
  });

  return route;
}
