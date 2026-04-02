import { Hono } from "hono";

/**
 * DEV-ONLY: Expose provider keys from .env.llm to the frontend.
 * Only registered when NODE_ENV !== "production" (see app.ts).
 *
 * The frontend uses this to auto-fill localStorage provider keys
 * so developers don't need to re-enter keys in the settings panel.
 *
 * Returns keys in frontend format: { "deepseek": "sk-...", "dashscope": "sk-..." }
 * matching the provider IDs used in settings-dialog.tsx and X-Provider-Keys header.
 */

/** Maps env var name → frontend provider ID */
const ENV_TO_PROVIDER: ReadonlyArray<[envVar: string, providerId: string]> = [
  ["DEEPSEEK_API_KEY", "deepseek"],
  ["DASHSCOPE_API_KEY", "dashscope"],
  ["OPENAI_API_KEY", "openai"],
  ["ANTHROPIC_API_KEY", "anthropic"],
  ["GOOGLE_API_KEY", "google"],
];

export function createDevKeysRoute() {
  const route = new Hono();

  route.get("/", (c) => {
    const keys: Record<string, string> = {};
    for (const [envVar, providerId] of ENV_TO_PROVIDER) {
      const value = process.env[envVar];
      if (value) {
        keys[providerId] = value;
      }
    }
    return c.json({ keys });
  });

  return route;
}
