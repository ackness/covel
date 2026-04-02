import { Hono } from "hono";

/**
 * DEV-ONLY: Expose provider keys from .env.llm to the frontend.
 * Only registered when NODE_ENV !== "production" AND ENABLE_DEV_KEYS=true.
 */

const ALLOWED_KEY_NAMES: ReadonlyArray<string> = [
  "DEEPSEEK_API_KEY",
  "DASHSCOPE_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
];

const ALLOWED_ENV_VARS: ReadonlySet<string> = new Set([
  ...ALLOWED_KEY_NAMES,
  ...ALLOWED_KEY_NAMES.map((k) => k.replace(/_API_KEY$/, "_BASE_URL")),
]);

export function createDevKeysRoute() {
  const route = new Hono();

  route.get("/", (c) => {
    if (process.env.ENABLE_DEV_KEYS !== "true") {
      return c.json({ keys: {} });
    }

    // Only return allowlisted env vars
    const keys: Record<string, string> = {};
    for (const name of ALLOWED_ENV_VARS) {
      const value = process.env[name];
      if (value) {
        keys[name.toLowerCase()] = value;
      }
    }
    return c.json({ keys });
  });

  return route;
}
