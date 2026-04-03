import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { worldDimensionsSchema } from "@covel/shared";
import type { AiStack } from "../../ai-setup.js";
import type { ServerStore } from "../../store/types.js";
import type { ApiKeyEnv } from "../../middleware/api-key-injection.js";

const requestSchema = z.object({
  prompt: z.string().min(1).max(4000),
  locale: z.string().optional(),
});

/**
 * Build the system prompt that instructs the LLM to generate a world.
 * The output must be a single JSON object matching the WorldDimensions schema
 * plus top-level `name`, `description`, `tags` fields.
 */
function buildSystemPrompt(locale: string): string {
  return `You are a world-building expert for tabletop RPGs and interactive fiction.
The user will describe a world concept. Generate a complete, richly-detailed world document in JSON format.

Output language: use "${locale}" for ALL text fields.

Your output MUST be a single valid JSON object with this exact structure:
{
  "name": "<short world name, 2-8 characters>",
  "description": "<one-line summary, under 80 characters>",
  "tags": ["<genre tag>", "<theme tag>", ...],
  "dimensions": {
    "geography": {
      "overview": "<geographic overview>",
      "regions": [
        {
          "name": "<region name>",
          "description": "<region description>",
          "climate": "<climate>",
          "landmarks": [{ "name": "<name>", "description": "<desc>" }]
        }
      ]
    },
    "factions": [
      {
        "id": "<unique_id>",
        "name": "<faction name>",
        "description": "<faction desc>",
        "type": "political|guild|corporate|religious|criminal|military|other",
        "influence": "major|minor",
        "leader": "<leader name>",
        "headquarters": "<location>",
        "relations": [{ "targetId": "<other faction id>", "type": "allied|neutral|hostile|vassal", "description": "<relation desc>" }]
      }
    ],
    "powerSystem": {
      "name": "<system name>",
      "type": "magic|technology|cultivation|psychic|hybrid|other",
      "description": "<how it works>",
      "rules": ["<rule 1>", "<rule 2>"],
      "tiers": [{ "name": "<tier name>", "rank": 0, "description": "<tier desc>" }]
    },
    "history": [
      { "era": "<era>", "year": "<year>", "name": "<event name>", "description": "<event desc>", "significance": "major|minor" }
    ],
    "economy": {
      "currencies": [{ "name": "<currency>", "symbol": "<sym>", "description": "<desc>" }],
      "resources": ["<resource 1>"],
      "tradeNotes": "<trade overview>"
    },
    "socialStructure": {
      "classes": [{ "name": "<class>", "description": "<desc>", "rank": 0 }],
      "races": [{ "name": "<race>", "description": "<desc>", "traits": ["<trait>"] }],
      "notes": "<social notes>"
    },
    "tone": {
      "genres": ["<genre>"],
      "contentRating": "all-ages|teen|mature",
      "narrativeStyle": "<style description>",
      "themes": ["<theme>"]
    },
    "mechanics": {
      "combatStyle": "turn-based|real-time|narrative|none",
      "skillSystem": "<skill system desc>",
      "difficulty": "easy|normal|hard|adaptive",
      "customRules": ["<rule>"]
    },
    "startingConditions": {
      "openingScenario": "<opening narrative>",
      "playerConstraints": ["<constraint>"],
      "startingLocation": "<location>",
      "startingResources": { "<resource>": 100 }
    }
  }
}

Requirements:
- Generate at least 3 regions, 3 factions, 4 history events, 2 currencies
- Factions must reference each other via relations using their IDs
- Power system tiers should have 3-5 levels
- Be creative, detailed, and internally consistent
- Output ONLY the JSON object, no markdown fences, no extra text`;
}

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
export function createGenerateWorldRoute(ai: AiStack, store: ServerStore) {
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

        const systemPrompt = buildSystemPrompt(locale);
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
