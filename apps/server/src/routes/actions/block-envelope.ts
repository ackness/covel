import type { RenderBlock } from "@covel/shared";

export function toBlockEnvelope(
  block: RenderBlock,
  meta: { turnId: string; sessionId: string; requestId: string; traceId: string }
) {
  let blockType = block.type;
  if (blockType === "choices") blockType = "choice_set";

  const data = normalizeBlockData(block);
  // Block types that require player response
  const INTERACTIVE_BLOCK_TYPES = new Set(["choice_set", "character_creation", "action_guide"]);
  const isInteractive = INTERACTIVE_BLOCK_TYPES.has(blockType);

  return {
    id: `block_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    type: blockType,
    version: "1.0",
    meta: {
      package: block.source?.pluginId ?? "kernel",
      pluginId: block.source?.pluginId,
      runtimeId: block.source?.runtimeId,
      requestId: meta.requestId,
      traceId: meta.traceId,
      sessionId: meta.sessionId,
      turnId: meta.turnId,
    },
    interaction: {
      requiresResponse: isInteractive,
      ...(isInteractive
        ? { responseSchema: "inline", submitAs: "block_response", resumePolicy: "continue" }
        : {}),
    },
    data,
  };
}

function normalizeBlockData(block: RenderBlock): Record<string, unknown> {
  const content = block.content as Record<string, unknown> | undefined;
  if (!content) return {};

  // Flatten nested content: { type: "choices", content: { title, options } } → { title, options }
  if (content.content && typeof content.content === "object") {
    return content.content as Record<string, unknown>;
  }

  return content;
}
