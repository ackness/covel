import { createMiddleware } from "hono/factory";

export type ApiKeyEnv = {
  Variables: {
    apiKeys: Record<string, string>;
  };
};

/**
 * Known provider env var mappings.
 * Maps provider name (used in presets) → env var name for API key.
 */
const PROVIDER_ENV_KEYS: ReadonlyArray<[provider: string, envVar: string]> = [
  ["deepseek", "DEEPSEEK_API_KEY"],
  ["dashscope", "DASHSCOPE_API_KEY"],
  ["openai", "OPENAI_API_KEY"],
  ["anthropic", "ANTHROPIC_API_KEY"],
  ["google", "GOOGLE_API_KEY"],
];

/**
 * Build API keys from server-side environment variables (.env.llm).
 * These serve as fallback when the frontend doesn't send keys.
 */
function getEnvApiKeys(): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const [provider, envVar] of PROVIDER_ENV_KEYS) {
    const value = process.env[envVar];
    if (value) {
      keys[provider] = value;
    }
  }
  return keys;
}

/**
 * Hono middleware that resolves API keys for LLM providers.
 *
 * Resolution order (per provider):
 * 1. X-Provider-Keys header (from browser localStorage, base64 JSON)
 * 2. Server-side env vars from .env.llm (fallback)
 *
 * This means:
 * - Frontend keys take priority (user explicitly configured)
 * - Server .env.llm keys are used when frontend doesn't provide them
 * - Both sources are merged, so a user can override just one provider
 */
export const apiKeyInjection = createMiddleware<ApiKeyEnv>(async (c, next) => {
  // Start with server-side env keys as base
  const envKeys = getEnvApiKeys();

  // Parse frontend-provided keys from header
  let headerKeys: Record<string, string> = {};
  const header = c.req.header("x-provider-keys");

  if (header) {
    try {
      const decoded = atob(header);
      const parsed = JSON.parse(decoded);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === "string" && v.length > 0) headerKeys[k] = v;
        }
      }
    } catch {
      return c.json({ error: "Invalid X-Provider-Keys header" }, 400);
    }
  }

  // Merge: header keys override env keys
  c.set("apiKeys", { ...envKeys, ...headerKeys });
  await next();
});
