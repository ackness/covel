import { resolve } from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { LOCALE_PATTERN, worldDimensionsSchema } from "@covel/shared";
import { loadPrompt, interpolate } from "@covel/context";
import type { AiStack } from "../../ai-setup.js";
import type { StoreService } from "../../store-service.js";
import type { ApiKeyEnv } from "../../middleware/api-key-injection.js";

const requestSchema = z.object({
  prompt: z.string().min(1).max(4000),
  locale: z.string().regex(LOCALE_PATTERN).optional(),
});

const PROMPTS_DIR = resolve(import.meta.dirname, "../../../../../prompts/server");

/** Attempt to extract JSON from the LLM response text. */
function extractJson(text: string): unknown {
  // Try direct parse first
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Try extracting from markdown code fence
    const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch?.[1]) {
      return JSON.parse(fenceMatch[1].trim());
    }
    // Try finding first { to last }
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    }
    throw new Error("Could not extract JSON from LLM response");
  }
}

const worldOutputSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  tags: z.array(z.string()).optional(),
  dimensions: worldDimensionsSchema,
});

/**
 * POST /api/ai/generate-world
 *
 * Generates a complete world from a user prompt via LLM.
 * Streams progress events via SSE, then creates the world in the store.
 *
 * SSE events:
 *   - { type: "progress", phase: "generating" }  — LLM is working
 *   - { type: "progress", phase: "validating" }   — validating output
 *   - { type: "progress", phase: "saving" }        — saving to store
 *   - { type: "done", world: WorldRecord }          — success
 *   - { type: "error", message: string }            — failure
 */
export function createGenerateWorldRoute(ai: AiStack, store: StoreService) {
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

    const { prompt, locale = "zh-CN" } = parsed.data;
    const apiKeys = c.get("apiKeys");

    return streamSSE(c, async (stream) => {
      try {
        // Phase 1: Generate
        await stream.writeSSE({
          data: JSON.stringify({ type: "progress", phase: "generating" }),
          event: "progress",
        });

        const template = await loadPrompt(PROMPTS_DIR, "generate-world", locale);
        const systemPrompt = interpolate(template, { locale });
        const result = await ai.gateway.generateText(
          {
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: prompt },
            ],
          },
          { apiKeys },
        );

        const rawText = result.text ?? "";
        if (!rawText.trim()) {
          throw new Error("LLM returned empty response");
        }

        // Phase 2: Validate
        await stream.writeSSE({
          data: JSON.stringify({ type: "progress", phase: "validating" }),
          event: "progress",
        });

        const jsonData = extractJson(rawText);
        const validated = worldOutputSchema.safeParse(jsonData);
        if (!validated.success) {
          const issues = validated.error.issues
            .slice(0, 3)
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ");
          throw new Error(`Generated world failed validation: ${issues}`);
        }

        const { name, description, tags, dimensions } = validated.data;

        // Phase 3: Save
        await stream.writeSSE({
          data: JSON.stringify({ type: "progress", phase: "saving" }),
          event: "progress",
        });

        const world = await store.createWorld(name, description, {
          locale,
          tags,
          dimensions,
        });

        await stream.writeSSE({
          data: JSON.stringify({ type: "done", world }),
          event: "done",
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "World generation failed";
        await stream.writeSSE({
          data: JSON.stringify({ type: "error", message }),
          event: "error",
        });
      }
    });
  });

  return route;
}
