import { Hono } from "hono";
import type { AiStack } from "../../ai-setup.js";
import type { ApiKeyEnv } from "../../middleware/api-key-injection.js";

/**
 * POST /api/ai/generate
 *
 * Non-streaming text generation.
 * Body: { presetId?, messages: [{ role, content }], providerRequestMetadata? }
 * Returns: { text, finishReason, usage }
 */
export function createGenerateRoute(ai: AiStack) {
  const route = new Hono<ApiKeyEnv>();

  route.post("/", async (c) => {
    const body = await c.req.json<{
      presetId?: string;
      messages: Array<{ role: string; content: string }>;
      providerRequestMetadata?: Record<string, unknown>;
    }>();

    if (!body.messages || !Array.isArray(body.messages)) {
      return c.json({ error: "messages array is required" }, 400);
    }

    const apiKeys = c.get("apiKeys");

    try {
      const result = await ai.gateway.generateText(
        {
          presetId: body.presetId,
          messages: body.messages,
          providerRequestMetadata: body.providerRequestMetadata,
        },
        { apiKeys }
      );

      return c.json(result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Generation failed";
      return c.json({ error: message }, 500);
    }
  });

  return route;
}
