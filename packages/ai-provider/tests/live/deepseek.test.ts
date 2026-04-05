import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { loadAiConfig } from "../../src/config/loader.js";
import { createProviderRegistry } from "../../src/provider-registry.js";
import { createPresetRegistry } from "../../src/preset-registry.js";
import { createGateway } from "../../src/gateway.js";
import type { StreamEvent } from "../../src/types.js";

const LIVE = process.env.LIVE_LLM_ENABLED === "1";

describe.skipIf(!LIVE)("live: deepseek", () => {
  function setup() {
    const config = loadAiConfig(
      resolve(import.meta.dirname, "../../presets/default.toml")
    );

    const providerRegistry = createProviderRegistry({
      providerDefaults: config.providers,
    });
    const presetRegistry = createPresetRegistry({
      profiles: config.profiles,
      presets: config.presets,
    });
    const gateway = createGateway({ providerRegistry, presetRegistry });

    const apiKeys: Record<string, string> = {};
    if (process.env.DEEPSEEK_API_KEY) {
      apiKeys.deepseek = process.env.DEEPSEEK_API_KEY;
    }

    return { gateway, apiKeys };
  }

  it(
    "generateText returns a response",
    { timeout: 30_000 },
    async () => {
      const { gateway, apiKeys } = setup();
      const result = await gateway.generateText(
        {
          presetId: "default",
          messages: [{ role: "user", content: "Say hello in one word." }],
        },
        { apiKeys }
      );

      expect(result.text.length).toBeGreaterThan(0);
      expect(result.usage.inputTokens).toBeGreaterThan(0);
    }
  );

  it(
    "streamText yields deltas then done",
    { timeout: 30_000 },
    async () => {
      const { gateway, apiKeys } = setup();
      const events: StreamEvent[] = [];

      for await (const event of gateway.streamText(
        {
          presetId: "default",
          messages: [{ role: "user", content: "Count to 3." }],
        },
        { apiKeys }
      )) {
        events.push(event);
      }

      const deltas = events.filter((e) => e.type === "text-delta");
      const done = events.find((e) => e.type === "done");

      expect(deltas.length).toBeGreaterThan(0);
      expect(done).toBeDefined();
      expect(done!.type).toBe("done");
    }
  );
});
