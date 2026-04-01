import type { ToolExecutionContext, ToolExecutionResult } from "@covel/shared";

/**
 * Generate a choices block for the player.
 *
 * The LLM calls this tool with a topic and optional custom options.
 * If no custom options are provided, generates sensible defaults.
 */
export async function generateChoicesTool(
  ctx: ToolExecutionContext<{
    topic?: string;
    options?: Array<{ id?: string; label: string }>;
  }>
): Promise<ToolExecutionResult> {
  const locale = ctx.locale;
  const isZh = locale.startsWith("zh");
  const topic = ctx.input?.topic ?? (isZh ? "当前情境" : "current situation");

  // Use LLM-provided options if available, otherwise provide defaults
  const rawOptions = ctx.input?.options;
  const options =
    rawOptions && rawOptions.length > 0
      ? rawOptions.map((opt, i) => ({
          id: opt.id ?? `opt_${String.fromCharCode(97 + i)}`,
          label: opt.label,
        }))
      : isZh
        ? [
            { id: "opt_a", label: "谨慎行动" },
            { id: "opt_b", label: "大胆尝试" },
            { id: "opt_c", label: "先观察情况" },
          ]
        : [
            { id: "opt_a", label: "Proceed cautiously" },
            { id: "opt_b", label: "Take a bold approach" },
            { id: "opt_c", label: "Observe first" },
          ];

  const choices = {
    title: isZh ? `${topic}` : `${topic}`,
    options,
  };

  return {
    output: {
      message: isZh
        ? `已为「${topic}」生成 ${options.length} 个选项。`
        : `Generated ${options.length} options for "${topic}".`,
    },
    proposals: [
      {
        kind: "ui.render",
        payload: {
          type: "choices",
          content: choices,
        },
      },
    ],
  };
}
