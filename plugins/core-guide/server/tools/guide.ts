import type { ToolExecutionContext, ToolExecutionResult } from "@covel/shared";

/**
 * Generate a choices block for the player.
 */
export async function generateChoicesTool(
  ctx: ToolExecutionContext<{ topic?: string }>
): Promise<ToolExecutionResult> {
  const locale = ctx.locale;
  const isZh = locale.startsWith("zh");
  const topic = ctx.input?.topic ?? (isZh ? "当前目标" : "current objective");

  const choices = {
    title: isZh ? `${topic} 的下一步` : `Next move for ${topic}`,
    options: [
      {
        id: "opt_a",
        label: isZh ? "继续前进" : "Advance",
      },
      {
        id: "opt_b",
        label: isZh ? "观察周围" : "Observe",
      },
    ],
  };

  return {
    output: {
      message: isZh
        ? `引导扩展已为 ${topic} 准备好选项。`
        : `Guide plugin prepared options for ${topic}.`,
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
