import type { RenderResult, RenderBlock } from "@covel/shared";
import type { TurnState } from "../types.js";

/**
 * Strip raw tool-call markup that LLMs sometimes emit in plain text.
 * Matches patterns like <call_tool(...)>...</call_tool> and <tool_result>...</tool_result>.
 */
function stripToolCallMarkup(text: string): string {
  return text
    .replace(/<call_tool\(.*?\)>[\s\S]*?<\/call_tool>/g, "")
    .replace(/<tool_result>[\s\S]*?<\/tool_result>/g, "")
    .replace(/\n{3,}/g, "\n\n");
}

/**
 * Build a RenderResult from the accumulated turn state.
 *
 * Produces blocks for:
 * 1. Narrative text (combined narrative segments)
 * 2. UI render blocks from proposals
 */
export function buildRenderResult(turnState: TurnState): RenderResult {
  const blocks: RenderBlock[] = [];

  // Narrative block — one per segment to preserve source ordering
  for (const segment of turnState.narrativeSegments) {
    const cleaned = stripToolCallMarkup(segment);
    if (cleaned.trim()) {
      blocks.push({
        type: "narrative",
        content: cleaned.trim(),
      });
    }
  }

  // UI render blocks
  for (const rb of turnState.renderBlocks) {
    blocks.push({
      type: rb.type,
      content: rb.content,
      source: rb.source,
    });
  }

  return { blocks };
}
