import type { ToolExecutionContext, ToolExecutionResult } from "@covel/shared";
import { z } from "zod";

// ── Types ───────────────────────────────────────────────────────

export type SuggestionStyle = "safe" | "aggressive" | "creative" | "wild";

export interface ActionCategory {
  readonly style: SuggestionStyle;
  readonly label: string;
  readonly suggestions: readonly string[];
}

export interface ActionGuideContent {
  readonly topic: string;
  readonly categories: readonly ActionCategory[];
}

// ── Zod Schemas ─────────────────────────────────────────────────

const suggestionStyleSchema = z.enum(["safe", "aggressive", "creative", "wild"]);

const actionCategorySchema = z.object({
  style: suggestionStyleSchema,
  label: z.string().optional(),
  suggestions: z.array(z.string().min(1)).min(1).max(4),
});

const generateActionGuideInputSchema = z.object({
  topic: z.string().min(1),
  categories: z.array(actionCategorySchema).min(1).max(4),
});

// ── Style Labels ────────────────────────────────────────────────

const STYLE_LABELS_ZH: Record<SuggestionStyle, string> = {
  safe: "稳妥",
  aggressive: "激进",
  creative: "创意",
  wild: "疯狂",
};

const STYLE_LABELS_EN: Record<SuggestionStyle, string> = {
  safe: "Safe",
  aggressive: "Aggressive",
  creative: "Creative",
  wild: "Wild",
};

function resolveLabel(style: SuggestionStyle, customLabel: string | undefined, isZh: boolean): string {
  if (customLabel) return customLabel;
  return isZh ? STYLE_LABELS_ZH[style] : STYLE_LABELS_EN[style];
}

// ── Tool Handler ────────────────────────────────────────────────

/**
 * Generate an action guide block with categorized suggestions.
 *
 * The LLM calls this tool with a topic and categorized suggestion groups
 * (safe/aggressive/creative/wild). Each category contains 1-4 actionable
 * suggestions for the player.
 */
export async function generateActionGuideTool(
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const isZh = ctx.locale.startsWith("zh");
  const parsed = generateActionGuideInputSchema.safeParse(ctx.input);

  if (!parsed.success) {
    return { output: { error: parsed.error.message } };
  }

  const { topic, categories } = parsed.data;

  const resolvedCategories: ActionCategory[] = categories.map((cat) => ({
    style: cat.style,
    label: resolveLabel(cat.style, cat.label, isZh),
    suggestions: cat.suggestions,
  }));

  const totalSuggestions = resolvedCategories.reduce(
    (sum, cat) => sum + cat.suggestions.length,
    0,
  );

  const content: ActionGuideContent = {
    topic,
    categories: resolvedCategories,
  };

  return {
    output: {
      message: isZh
        ? `已为「${topic}」生成 ${resolvedCategories.length} 类共 ${totalSuggestions} 条建议。`
        : `Generated ${totalSuggestions} suggestions in ${resolvedCategories.length} categories for "${topic}".`,
    },
    proposals: [
      {
        kind: "ui.render",
        payload: {
          type: "action_guide",
          content,
        },
      },
    ],
  };
}
