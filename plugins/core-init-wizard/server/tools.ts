import type { ToolExecutionContext, ToolExecutionResult, DynamicFieldSchema } from "@covel/shared";
import { buildCharacterCreationBlock } from "./logic.js";

/**
 * Emit the character creation form as a ui.render proposal.
 * Reads characterFieldSchema from state to include bio fields if available.
 */
export async function emitCharacterFormTool(
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const isZh = ctx.locale.startsWith("zh");
  const state = ctx.state as Record<string, unknown> | undefined;
  const schema = state?.characterFieldSchema as DynamicFieldSchema | undefined;

  const block = buildCharacterCreationBlock(ctx.locale, schema);

  return {
    output: {
      message: isZh
        ? "角色创建表单已显示。"
        : "Character creation form displayed.",
    },
    proposals: [block],
  };
}
