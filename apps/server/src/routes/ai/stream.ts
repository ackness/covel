import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AiStack } from "../../ai-setup.js";
import type { ApiKeyEnv } from "../../middleware/api-key-injection.js";

/**
 * POST /api/ai/stream
 *
 * Streaming text generation via Server-Sent Events.
 * Body: { presetId?, messages: [{ role, content }], providerRequestMetadata? }
 * Response: text/event-stream with JSON-encoded StreamEvent per line.
 */
export function createStreamRoute(ai: AiStack) {
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

    return streamSSE(c, async (stream) => {
      try {
        for await (const event of ai.gateway.streamText(
          {
            presetId: body.presetId,
            messages: body.messages,
            providerRequestMetadata: body.providerRequestMetadata,
          },
          { apiKeys }
        )) {
          await stream.writeSSE({
            data: JSON.stringify(event),
            event: event.type,
          });
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Stream failed";
        await stream.writeSSE({
          data: JSON.stringify({ type: "error", message }),
          event: "error",
        });
      }
    });
  });

  return route;
}
