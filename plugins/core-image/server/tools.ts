import type { ToolExecutionContext, ToolExecutionResult } from "@covel/shared";
import { z } from "zod";

// ── Zod Schemas ─────────────────────────────────────────────────

const requestImageInputSchema = z.object({
  storyBackground: z.string(),
  scenePrompt: z.string(),
  continuityNotes: z.string().optional(),
  layoutPreference: z.enum(["single", "comic", "auto"]).optional(),
  stylePreset: z.string().optional(),
  negativePrompt: z.string().optional(),
});

// ── Tool: request-story-image ───────────────────────────────────

/**
 * Tool: request-story-image
 *
 * Validates input and emits an image.requested event.
 * The actual generation happens in the runtime handler.
 */
export async function requestStoryImageTool(
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const isZh = ctx.locale.startsWith("zh");
  const parsed = requestImageInputSchema.safeParse(ctx.input);
  if (!parsed.success) {
    return { output: { error: parsed.error.message } };
  }
  const input = parsed.data;

  return {
    output: {
      message: isZh
        ? `已请求生成故事插画：${input.scenePrompt.slice(0, 50)}...`
        : `Requested story image generation: ${input.scenePrompt.slice(0, 50)}...`,
    },
    proposals: [
      {
        kind: "event.emit",
        payload: {
          type: "image.generation.requested",
          storyBackground: input.storyBackground,
          scenePrompt: input.scenePrompt,
          continuityNotes: input.continuityNotes,
          layoutPreference: input.layoutPreference,
          stylePreset: input.stylePreset,
          negativePrompt: input.negativePrompt,
        },
      },
    ],
  };
}
