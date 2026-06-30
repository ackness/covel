/**
 * Plugin-local tool: generate-guide
 *
 * Generates a categorized action guide for the player.
 * Each category (safe/aggressive/creative/wild) provides
 * 1-3 concrete, actionable suggestions.
 *
 * Returns UI blocks that json-render renders as styled choice cards.
 */

import { withPendingProposals } from "@covel/tools";

const STYLE_CONFIG = {
  safe: { zh: "稳妥", en: "Safe", icon: "shield", color: "blue" },
  aggressive: { zh: "激进", en: "Aggressive", icon: "swords", color: "red" },
  creative: { zh: "创意", en: "Creative", icon: "lightbulb", color: "purple" },
  wild: { zh: "疯狂", en: "Wild", icon: "flame", color: "amber" },
};

export default function ({ tool, z }) {
  const categorySchema = z.object({
    style: z.enum(["safe", "aggressive", "creative", "wild"]),
    label: z.string().optional(),
    suggestions: z
      .array(z.string().min(1))
      .min(1)
      .max(3)
      .describe("1-3 个具体的行动建议"),
  });

  return tool({
    name: "generate-guide",
    description:
      "生成分风格的行动引导。为玩家提供不同风格（稳妥/激进/创意/疯狂）的选择建议。",
    parameters: z.object({
      topic: z.string().min(1).describe("当前决策点的简要描述"),
      categories: z
        .array(categorySchema)
        .min(2)
        .max(4)
        .describe("2-4 个风格分类，每个包含 1-3 个建议"),
    }),
    execute: async (params, context) => {
      const { topic, categories } = params;

      const resolvedCategories = categories.map((cat, index) => {
        const config = STYLE_CONFIG[cat.style];
        return {
          slot: index + 1,
          style: cat.style,
          // Store an I18nText label so the block resolves it to the session
          // locale. An LLM-supplied `cat.label` is a single string in the
          // session language; otherwise fall back to the bilingual config
          // (previously only the zh half was used → en players saw Chinese).
          label: cat.label ?? { zh: config.zh, en: config.en },
          icon: config.icon,
          color: config.color,
          suggestions: cat.suggestions,
        };
      });

      const now = new Date().toISOString();
      const messageRecords = [
        {
          id: crypto.randomUUID(),
          sessionId: context.sessionId,
          pluginId: context.pluginId,
          namespace: "message",
          key: "__turnId",
          value: context.turnId,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: crypto.randomUUID(),
          sessionId: context.sessionId,
          pluginId: context.pluginId,
          namespace: "message",
          key: "topic",
          value: topic,
          createdAt: now,
          updatedAt: now,
        },
      ];

      for (const category of resolvedCategories.slice(0, 3)) {
        messageRecords.push(
          {
            id: crypto.randomUUID(),
            sessionId: context.sessionId,
            pluginId: context.pluginId,
            namespace: "message",
            key: `category${category.slot}Label`,
            value: category.label,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: crypto.randomUUID(),
            sessionId: context.sessionId,
            pluginId: context.pluginId,
            namespace: "message",
            key: `category${category.slot}Icon`,
            value: category.icon,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: crypto.randomUUID(),
            sessionId: context.sessionId,
            pluginId: context.pluginId,
            namespace: "message",
            key: `category${category.slot}Color`,
            value: category.color,
            createdAt: now,
            updatedAt: now,
          },
        );

        for (let i = 0; i < 3; i += 1) {
          messageRecords.push({
            id: crypto.randomUUID(),
            sessionId: context.sessionId,
            pluginId: context.pluginId,
            namespace: "message",
            key: `category${category.slot}Suggestion${i + 1}`,
            value: category.suggestions[i] ?? "",
            createdAt: now,
            updatedAt: now,
          });
        }
      }

      return withPendingProposals(
        {
          topic,
          categories: resolvedCategories,
        },
        [
          {
            id: crypto.randomUUID(),
            type: "plugin.data.batch",
            source: {
              pluginId: context.pluginId,
              runtimeId: context.runtimeId,
            },
            turnId: context.turnId,
            sessionId: context.sessionId,
            payload: {
              items: messageRecords.map((record) => ({
                namespace: record.namespace,
                key: record.key,
                value: record.value,
              })),
            },
            timestamp: now,
          },
        ],
      );
    },
  });
}
