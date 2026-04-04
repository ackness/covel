import { resolve } from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { worldDimensionsSchema } from "@covel/shared";
import { loadPrompt, interpolate } from "@covel/context";
import type { AiStack } from "../../ai-setup.js";
import type { ApiKeyEnv } from "../../middleware/api-key-injection.js";

const requestSchema = z.object({
  lore: z.string().min(1).max(50000),
  locale: z.string().regex(/^[a-zA-Z]{2,8}(-[a-zA-Z0-9]{2,8})*$/).optional(),
});

const PROMPTS_DIR = resolve(import.meta.dirname, "../../../../../prompts/server");

/** Attempt to extract JSON from the LLM response text. */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch?.[1]) {
      return JSON.parse(fenceMatch[1].trim());
    }
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    }
    throw new Error("Could not extract JSON from LLM response");
  }
}

/**
 * POST /api/ai/extract-dimensions
 *
 * Extracts structured WorldDimensions from a lore text using LLM.
 * Streams progress events via SSE.
 *
 * SSE events:
 *   - { type: "progress", phase: "extracting" }
 *   - { type: "done", dimensions: WorldDimensions }
 *   - { type: "error", message: string }
 */
export function createExtractDimensionsRoute(ai: AiStack) {
  const route = new Hono<ApiKeyEnv>();

  route.post("/", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid input" },
        400,
      );
    }

    const { lore, locale = "zh-CN" } = parsed.data;
    const apiKeys = c.get("apiKeys");

    return streamSSE(c, async (stream) => {
      try {
        await stream.writeSSE({
          data: JSON.stringify({ type: "progress", phase: "extracting" }),
          event: "progress",
        });

        const template = await loadPrompt(PROMPTS_DIR, "extract-dimensions", locale);
        const systemPrompt = interpolate(template, { locale });
        const result = await ai.gateway.generateText(
          {
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: lore },
            ],
          },
          { apiKeys },
        );

        const rawText = result.text ?? "";
        if (!rawText.trim()) {
          throw new Error("LLM returned empty response");
        }

        await stream.writeSSE({
          data: JSON.stringify({ type: "progress", phase: "validating" }),
          event: "progress",
        });

        const jsonData = extractJson(rawText);
        const validated = worldDimensionsSchema.safeParse(jsonData);
        if (!validated.success) {
          const issues = validated.error.issues
            .slice(0, 3)
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ");
          throw new Error(`Extracted dimensions failed validation: ${issues}`);
        }

        await stream.writeSSE({
          data: JSON.stringify({ type: "done", dimensions: validated.data }),
          event: "done",
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Dimension extraction failed";
        await stream.writeSSE({
          data: JSON.stringify({ type: "error", message }),
          event: "error",
        });
      }
    });
  });

  return route;
}
