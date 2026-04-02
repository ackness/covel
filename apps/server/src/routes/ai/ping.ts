import { Hono } from "hono";
import type { AiStack } from "../../ai-setup.js";
import type { ApiKeyEnv } from "../../middleware/api-key-injection.js";

/**
 * POST /api/ai/ping
 *
 * Lightweight connectivity test. Sends a minimal "hi" to the specified
 * preset via the AI gateway using streaming. Returns TTFB (time to first
 * text-delta) as latencyMs, plus a short text preview.
 *
 * Body: { presetId: string }
 * Returns: { ok, latencyMs, ttfbMs, text, usage?, error? }
 */
export function createPingRoute(ai: AiStack) {
  const route = new Hono<ApiKeyEnv>();

  route.post("/", async (c) => {
    const body = await c.req.json<{ presetId: string }>();

    if (!body.presetId) {
      return c.json({ ok: false, error: "presetId is required" }, 400);
    }

    const apiKeys = c.get("apiKeys");
    const start = performance.now();

    try {
      let ttfbMs: number | null = null;
      let text = "";
      let usage: { inputTokens: number; outputTokens: number } | undefined;

      for await (const event of ai.gateway.streamText(
        {
          presetId: body.presetId,
          messages: [{ role: "user", content: "hi" }],
        },
        { apiKeys }
      )) {
        if (event.type === "reasoning-delta" || event.type === "text-delta") {
          if (ttfbMs === null) {
            ttfbMs = Math.round(performance.now() - start);
          }
          if (event.type === "text-delta" && text.length < 200) {
            text += event.textDelta;
          }
        }
        if (event.type === "done" && event.usage) {
          usage = {
            inputTokens: event.usage.inputTokens,
            outputTokens: event.usage.outputTokens,
          };
        }
      }

      const totalMs = Math.round(performance.now() - start);

      return c.json({
        ok: true,
        latencyMs: ttfbMs ?? totalMs,
        ttfbMs: ttfbMs ?? totalMs,
        text: text.slice(0, 200),
        usage,
      });
    } catch (error) {
      const latencyMs = Math.round(performance.now() - start);
      const message = error instanceof Error ? error.message : "Ping failed";
      return c.json({ ok: false, latencyMs, error: message }, 502);
    }
  });

  return route;
}
