import type { RenderResult, RenderBlock } from "@covel/shared";
import type { TurnState } from "../types.js";

/**
 * Build a RenderResult from the accumulated turn state.
 *
 * Produces blocks for:
 * 1. Narrative text (combined narrative segments)
 * 2. UI render blocks from proposals
 */
export function buildRenderResult(turnState: TurnState): RenderResult {
  const blocks: RenderBlock[] = [];

  // Narrative block
  if (turnState.narrativeSegments.length > 0) {
    blocks.push({
      type: "narrative",
      content: turnState.narrativeSegments.join(""),
    });
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
