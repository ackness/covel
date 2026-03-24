import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createModelGateway,
  createModelProfileRegistry,
  createProviderRegistry,
  type ModelProfile,
  type PresetMetadata
} from "../src/index.js";

const LIVE_LLM_ENABLED = process.env.LIVE_LLM_ENABLED === "1";
const LIVE_LLM_PRIMARY_BASE_URL = process.env.LIVE_LLM_PRIMARY_BASE_URL;
const LIVE_LLM_PRIMARY_API_KEY = process.env.LIVE_LLM_PRIMARY_API_KEY;
const LIVE_LLM_PRIMARY_MODEL = process.env.LIVE_LLM_PRIMARY_MODEL ?? "qwen3.5-flash";

const runtimeProfiles: ModelProfile[] = [
  {
    id: "medium",
    tier: "medium",
    provider: "openaiCompatible",
    model: LIVE_LLM_PRIMARY_MODEL,
    contextWindow: 128_000,
    latencyClass: "medium",
    costClass: "medium",
    supportedModes: ["text", "object", "stream"]
  },
  {
    id: "embed-default",
    tier: "embed-default",
    provider: "openaiCompatible",
    model: "embed-default-placeholder",
    contextWindow: 8_000,
    latencyClass: "low",
    costClass: "low",
    supportedModes: ["embed"]
  }
];

const runtimePreset: PresetMetadata = {
  id: "live-default",
  name: "Live default",
  provider: "openaiCompatible",
  model: LIVE_LLM_PRIMARY_MODEL,
  tier: "medium",
  baseUrl: LIVE_LLM_PRIMARY_BASE_URL,
  supportedModes: ["text", "object", "stream"],
  enabled: true,
  isDefault: true,
  scope: "global"
};

function createLiveGateway() {
  const providerRegistry = createProviderRegistry({
    providers: {
      openaiCompatible: {
        defaults: {
          baseUrl: LIVE_LLM_PRIMARY_BASE_URL,
          apiKey: LIVE_LLM_PRIMARY_API_KEY
        }
      }
    }
  });

  const profileRegistry = createModelProfileRegistry({
    runtimeProfiles,
    runtimePresets: [runtimePreset]
  });

  return createModelGateway({
    providerRegistry,
    profileRegistry
  });
}

const shouldRunLive =
  LIVE_LLM_ENABLED &&
  typeof LIVE_LLM_PRIMARY_BASE_URL === "string" &&
  LIVE_LLM_PRIMARY_BASE_URL.length > 0 &&
  typeof LIVE_LLM_PRIMARY_API_KEY === "string" &&
  LIVE_LLM_PRIMARY_API_KEY.length > 0;

describe.skipIf(!shouldRunLive)("openai-compatible live smoke", () => {
  it("generates non-empty text with the configured live model", async () => {
    const gateway = createLiveGateway();

    const result = await gateway.generateText({
      presetId: "live-default",
      messages: [
        {
          role: "user",
          content: "Reply with one short sentence about a frozen frontier."
        }
      ]
    });

    expect(result.text.trim().length).toBeGreaterThan(0);
    expect(result.usage.inputTokens).toBeGreaterThanOrEqual(0);
    expect(result.usage.outputTokens).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it("generates schema-valid structured output", async () => {
    const gateway = createLiveGateway();

    const result = await gateway.generateObject({
      presetId: "live-default",
      schema: z.object({
        title: z.string(),
        mood: z.string()
      }),
      messages: [
        {
          role: "user",
          content: [
            "Return a JSON object with keys title and mood.",
            "title should be a short scene title.",
            "mood should be a one-word tone."
          ].join(" ")
        }
      ]
    });

    expect(result.object.title.trim().length).toBeGreaterThan(0);
    expect(result.object.mood.trim().length).toBeGreaterThan(0);
  }, 60_000);

  it("streams at least one delta and a terminal done event", async () => {
    const gateway = createLiveGateway();
    const events = [];

    for await (const event of gateway.streamText({
      presetId: "live-default",
      messages: [
        {
          role: "user",
          content: "Stream a short atmospheric description of a ruined observatory."
        }
      ]
    })) {
      events.push(event);
    }

    expect(events.some((event) => event.type === "text-delta")).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "done"
    });
  }, 60_000);
});
