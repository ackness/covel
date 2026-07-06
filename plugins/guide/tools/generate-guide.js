/**
 * Plugin-local tool: generate-guide
 *
 * Generates a categorized action guide for the player.
 * Each category (safe/aggressive/creative/wild) provides
 * 1-3 concrete, actionable suggestions.
 *
 * Returns UI blocks that json-render renders as styled choice cards.
 */

import { makeProposal } from "@covel/plugin-handlers-utils";
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
      .describe("1-3 concrete, actionable suggestions"),
  });

  return tool({
    name: "generate-guide",
    description:
      "Generate a style-categorized action guide, offering the player choices in different styles (safe / aggressive / creative / wild).",
    parameters: z.object({
      topic: z
        .string()
        .min(1)
        .describe("A brief description of the current decision point"),
      categories: z
        .array(categorySchema)
        // Capped at 3: the message block has exactly 3 strategy slots and the
        // handler slices to 3, so a 4th category would be silently dropped.
        .min(2)
        .max(3)
        .describe("2-3 style categories, each with 1-3 suggestions"),
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
      // plugin.data.batch items only need {namespace, key, value} — the commit
      // handler owns ids/timestamps.
      const items = [
        { namespace: "message", key: "__turnId", value: context.turnId },
        { namespace: "message", key: "topic", value: topic },
      ];

      for (const category of resolvedCategories.slice(0, 3)) {
        items.push(
          {
            namespace: "message",
            key: `category${category.slot}Label`,
            value: category.label,
          },
          {
            namespace: "message",
            key: `category${category.slot}Icon`,
            value: category.icon,
          },
          {
            namespace: "message",
            key: `category${category.slot}Color`,
            value: category.color,
          },
        );

        for (let i = 0; i < 3; i += 1) {
          items.push({
            namespace: "message",
            key: `category${category.slot}Suggestion${i + 1}`,
            value: category.suggestions[i] ?? "",
          });
        }
      }

      return withPendingProposals(
        {
          topic,
          categories: resolvedCategories,
        },
        [makeProposal(context, now, "plugin.data.batch", { items })],
      );
    },
  });
}
