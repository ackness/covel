import { createMiddleware } from "hono/factory";

export type ApiKeyEnv = {
  Variables: {
    apiKeys: Record<string, string>;
  };
};

/**
 * Well-known provider → env var mappings.
 * Used as baseline; any provider can also be auto-derived via
 * "{PROVIDER_UPPER}_API_KEY" convention.
 */
const WELL_KNOWN_PROVIDERS: ReadonlyArray<[provider: string, envVar: string]> = [
  ["deepseek", "DEEPSEEK_API_KEY"],
  ["dashscope", "DASHSCOPE_API_KEY"],
  ["openai", "OPENAI_API_KEY"],
  ["anthropic", "ANTHROPIC_API_KEY"],
  ["google", "GOOGLE_API_KEY"],
];

/** Derive env var name from provider id: "my-provider" → "MY_PROVIDER_API_KEY". */
function providerToEnvVar(provider: string): string {
  return `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
}

/**
 * Build API keys from server-side environment variables (.env.llm).
 *
 * Checks well-known providers first, then scans all env vars matching
 * the *_API_KEY pattern to support custom providers.
 */
function getEnvApiKeys(): Record<string, string> {
  const keys: Record<string, string> = {};

  // Well-known providers
  for (const [provider, envVar] of WELL_KNOWN_PROVIDERS) {
    const value = process.env[envVar];
    if (value) {
      keys[provider] = value;
    }
  }

  // Auto-discover additional *_API_KEY env vars
  for (const [envVar, value] of Object.entries(process.env)) {
    if (!envVar.endsWith("_API_KEY") || !value) continue;
    const provider = envVar.slice(0, -8).toLowerCase().replace(/_/g, "-");
    if (!keys[provider]) {
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
 * Frontend keys take priority; both sources are merged.
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
