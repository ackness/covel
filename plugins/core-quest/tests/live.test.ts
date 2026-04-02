import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import {
  loadAiConfig,
  createProviderRegistry,
  createPresetRegistry,
  createGateway,
  type StreamEvent,
} from "@covel/ai-provider";

const LIVE = process.env.LIVE_LLM_ENABLED === "1";

describe.skipIf(!LIVE)("live: quest detection with qwen3.5-flash", () => {
  function setup() {
    const config = loadAiConfig(
      resolve(import.meta.dirname, "../../../packages/ai-provider/presets/default.toml"),
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
    "detects quest from narrative with NPC task assignment",
    async () => {
      const { gateway, apiKeys } = setup();

      const narrative = `
        村长走到你面前，神色凝重地说道："勇士，我们村子里的祖传护身符被偷走了。
        听说它被藏在北边的废弃矿洞深处。你能帮我们找回来吗？
        如果你成功了，我会用一把银剑作为报答。"
      `;

      const prompt = `You are a quest detection system. Analyze the following narrative and extract any quests/missions.

Respond in JSON format:
{
  "hasQuest": boolean,
  "quest": {
    "title": string,
    "description": string,
    "type": "main" | "side" | "hidden",
    "objectives": [{ "description": string }],
    "giverNpc": string | null,
    "rewards": string | null
  } | null
}

Narrative:
${narrative}`;

      const result = await gateway.generateText(
        {
          presetId: "dashscope-qwen-flash",
          messages: [{ role: "user", content: prompt }],
        },
        { apiKeys },
      );

      expect(result.text.length).toBeGreaterThan(0);

      // Try to parse the JSON response (may be wrapped in markdown code block)
      const jsonMatch = result.text.match(/\{[\s\S]*\}/);
      expect(jsonMatch).not.toBeNull();

      const parsed = JSON.parse(jsonMatch![0]) as {
        hasQuest: boolean;
        quest: {
          title: string;
          objectives: Array<{ description: string }>;
          giverNpc: string | null;
        } | null;
      };

      expect(parsed.hasQuest).toBe(true);
      expect(parsed.quest).not.toBeNull();
      expect(parsed.quest!.title.length).toBeGreaterThan(0);
      expect(parsed.quest!.objectives.length).toBeGreaterThan(0);
      expect(parsed.quest!.giverNpc).toBeTruthy();
    },
    { timeout: 30_000 },
  );

  it(
    "does not detect quest from casual conversation",
    async () => {
      const { gateway, apiKeys } = setup();

      const narrative = `
        你走进酒馆，点了一杯麦酒。酒保热情地招呼你坐下，
        聊起了最近的天气和收成。"今年的小麦长得不错，"他说，
        "希望明年也是个好年景。"
      `;

      const prompt = `You are a quest detection system. Analyze the following narrative and extract any quests/missions.

Respond in JSON format:
{
  "hasQuest": boolean,
  "quest": null
}

Only set hasQuest to true if there is a clear task, mission, or objective given to the player. Casual conversation, rumors, or general statements are NOT quests.

Narrative:
${narrative}`;

      const result = await gateway.generateText(
        {
          presetId: "dashscope-qwen-flash",
          messages: [{ role: "user", content: prompt }],
        },
        { apiKeys },
      );

      const jsonMatch = result.text.match(/\{[\s\S]*\}/);
      expect(jsonMatch).not.toBeNull();

      const parsed = JSON.parse(jsonMatch![0]) as { hasQuest: boolean };
      expect(parsed.hasQuest).toBe(false);
    },
    { timeout: 30_000 },
  );
});
