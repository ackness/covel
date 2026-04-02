import { describe, it, expect } from "vitest";
import { resolve } from "node:path";

/**
 * Live LLM test: verifies the inventory-tracker runtime can detect items
 * from narrative text using a real LLM (qwen3.5-flash via dashscope).
 *
 * Run with: LIVE_LLM_ENABLED=1 DASHSCOPE_API_KEY=... pnpm test:live
 */

const LIVE = process.env.LIVE_LLM_ENABLED === "1";

describe.skipIf(!LIVE)("live: inventory-tracker with LLM", () => {
  async function setupGateway() {
    const {
      loadAiConfig,
      createProviderRegistry,
      createPresetRegistry,
      createGateway,
    } = await import("@covel/ai-provider");

    const config = loadAiConfig(
      resolve(
        import.meta.dirname,
        "../../../packages/ai-provider/presets/default.toml"
      )
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
    if (process.env.DASHSCOPE_API_KEY) {
      apiKeys.dashscope = process.env.DASHSCOPE_API_KEY;
    }

    return { gateway, apiKeys };
  }

  it(
    "detects item acquisition from narrative text",
    async () => {
      const { gateway, apiKeys } = await setupGateway();

      const narrative = `
The old merchant smiles and slides a small vial across the counter.
"A healing potion — on the house," he says. He also tosses you a leather pouch
containing 50 gold coins. "For your troubles on the road."
You pick up a rusted iron dagger from the shelf, adding it to your belt.
      `.trim();

      const systemPrompt = `You are an inventory tracker for an RPG game.
Analyze the following narrative and list ALL items the player acquired.
For each item, output a JSON object with: name, category (weapon/armor/consumable/quest/material/misc), quantity.
Also list any currency changes as: currency_name, amount.
Output ONLY valid JSON array. No other text.`;

      const result = await gateway.generateText(
        {
          presetId: "dashscope-qwen-flash",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: narrative },
          ],
        },
        { apiKeys }
      );

      expect(result.text.length).toBeGreaterThan(0);

      // Extract JSON from the response (may be wrapped in markdown code blocks)
      const jsonMatch = result.text.match(/\[[\s\S]*\]/);
      expect(jsonMatch).not.toBeNull();

      const parsed = JSON.parse(jsonMatch![0]) as Array<Record<string, unknown>>;
      expect(parsed.length).toBeGreaterThanOrEqual(2);

      // Should detect healing potion
      const hasPotion = parsed.some(
        (item) =>
          typeof item.name === "string" &&
          item.name.toLowerCase().includes("potion")
      );
      expect(hasPotion).toBe(true);

      // Should detect dagger
      const hasDagger = parsed.some(
        (item) =>
          typeof item.name === "string" &&
          item.name.toLowerCase().includes("dagger")
      );
      expect(hasDagger).toBe(true);
    },
    30_000
  );

  it(
    "detects item consumption from narrative text",
    async () => {
      const { gateway, apiKeys } = await setupGateway();

      const narrative = `
You uncork the healing potion and drink it in one gulp.
Warmth spreads through your body as the wounds begin to close.
      `.trim();

      const systemPrompt = `You are an inventory tracker for an RPG game.
Analyze the following narrative and identify items that were USED or CONSUMED.
For each item, output a JSON object with: name, action (one of: "used", "removed", "equipped", "unequipped").
Output ONLY valid JSON array. No other text.`;

      const result = await gateway.generateText(
        {
          presetId: "dashscope-qwen-flash",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: narrative },
          ],
        },
        { apiKeys }
      );

      expect(result.text.length).toBeGreaterThan(0);

      const jsonMatch = result.text.match(/\[[\s\S]*\]/);
      expect(jsonMatch).not.toBeNull();

      const parsed = JSON.parse(jsonMatch![0]) as Array<Record<string, unknown>>;
      expect(parsed.length).toBeGreaterThanOrEqual(1);

      const hasPotion = parsed.some(
        (item) =>
          typeof item.name === "string" &&
          item.name.toLowerCase().includes("potion") &&
          typeof item.action === "string" &&
          item.action === "used"
      );
      expect(hasPotion).toBe(true);
    },
    30_000
  );
});
