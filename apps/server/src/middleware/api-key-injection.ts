import { createMiddleware } from "hono/factory";

export type ApiKeyEnv = {
  Variables: {
    apiKeys: Record<string, string>;
  };
};

/**
 * Hono middleware that decodes API keys from the X-Provider-Keys header.
 *
 * Expected header format:
 *   X-Provider-Keys: base64(JSON.stringify({ "deepseek": "sk-...", "dashscope": "sk-..." }))
 *
 * Decoded keys are stored in context via c.get("apiKeys").
 * If the header is missing, an empty object is set.
 */
export const apiKeyInjection = createMiddleware<ApiKeyEnv>(async (c, next) => {
  const header = c.req.header("x-provider-keys");
  let apiKeys: Record<string, string> = {};

  if (header) {
    try {
      const decoded = atob(header);
      const parsed = JSON.parse(decoded);
      if (typeof parsed === "object" && parsed !== null) {
        apiKeys = parsed;
      }
    } catch {
      return c.json({ error: "Invalid X-Provider-Keys header" }, 400);
    }
  }

  c.set("apiKeys", apiKeys);
  await next();
});
