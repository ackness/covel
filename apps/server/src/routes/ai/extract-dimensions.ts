import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { worldDimensionsSchema } from "@covel/shared";
import type { AiStack } from "../../ai-setup.js";
import type { ApiKeyEnv } from "../../middleware/api-key-injection.js";

const requestSchema = z.object({
  lore: z.string().min(1).max(50000),
  locale: z.string().optional(),
});

/**
 * Build the system prompt for dimension extraction.
 * Instructs the LLM to extract structured WorldDimensions from lore text.
 */
function buildExtractionPrompt(locale: string): string {
  return `You are a world-building structure expert. Your task is to extract structured dimensions from a world lore document.

Output language: use "${locale}" for ALL text fields.

Read the provided world lore document carefully and extract the following 9 dimensions into a single JSON object matching the WorldDimensions schema:

{
  "geography": {
    "overview": "<geographic overview>",
    "regions": [{ "name": "<name>", "description": "<desc>", "climate": "<climate>", "landmarks": [{ "name": "<name>", "description": "<desc>" }] }]
  },
  "factions": [{ "id": "<unique_id>", "name": "<name>", "description": "<desc>", "type": "political|guild|corporate|religious|criminal|military|other", "influence": "major|minor", "leader": "<leader>", "headquarters": "<location>", "relations": [{ "targetId": "<id>", "type": "allied|neutral|hostile|vassal" }] }],
  "powerSystem": { "name": "<name>", "type": "magic|technology|cultivation|psychic|hybrid|other", "description": "<desc>", "rules": ["<rule>"], "tiers": [{ "name": "<name>", "rank": 0, "description": "<desc>" }] },
  "history": [{ "era": "<era>", "year": "<year>", "name": "<name>", "description": "<desc>", "significance": "major|minor" }],
  "economy": { "currencies": [{ "name": "<name>", "symbol": "<sym>", "description": "<desc>" }], "resources": ["<resource>"], "tradeNotes": "<notes>" },
  "socialStructure": { "classes": [{ "name": "<name>", "description": "<desc>", "rank": 0 }], "races": [{ "name": "<name>", "description": "<desc>", "traits": ["<trait>"] }], "notes": "<notes>" },
  "tone": { "genres": ["<genre>"], "contentRating": "all-ages|teen|mature", "narrativeStyle": "<style>", "themes": ["<theme>"] },
  "mechanics": { "combatStyle": "turn-based|real-time|narrative|none", "skillSystem": "<desc>", "difficulty": "easy|normal|hard|adaptive", "customRules": ["<rule>"] },
  "startingConditions": { "openingScenario": "<scenario>", "playerConstraints": ["<constraint>"], "startingLocation": "<location>", "startingResources": { "<resource>": 100 } }
}

Critical rules:
- ONLY extract information explicitly stated or clearly implied in the document
- Do NOT invent or fabricate details not present in the lore
- If a dimension is not mentioned in the document, OMIT that entire field
- Output ONLY the JSON object, no markdown fences, no extra text
- Each dimension field is optional — include only what the lore supports`;
}

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

        const systemPrompt = buildExtractionPrompt(locale);
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
