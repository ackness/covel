import type {
  RuntimeHandler,
  RuntimeHandlerContext,
  RuntimeHandlerResult,
} from "@covel/plugin-runtime";
import {
  buildEnhancePrompt,
  detectMultiScene,
  addImageResult,
  EMPTY_STATE,
  type ImageRequest,
  type EnhancedPrompt,
  type ImageResult,
  type ImageState,
} from "./image-logic.js";

// ── Helpers ─────────────────────────────────────────────────────

function extractImageRequest(
  context: unknown,
): ImageRequest | undefined {
  if (
    context !== null &&
    context !== undefined &&
    typeof context === "object" &&
    "event" in context
  ) {
    const event = (context as Record<string, unknown>).event;
    if (
      event !== null &&
      event !== undefined &&
      typeof event === "object" &&
      "type" in event &&
      (event as Record<string, unknown>).type === "image.requested"
    ) {
      const payload = event as Record<string, unknown>;
      if (
        typeof payload.storyBackground === "string" &&
        typeof payload.scenePrompt === "string"
      ) {
        return {
          storyBackground: payload.storyBackground,
          scenePrompt: payload.scenePrompt,
          continuityNotes:
            typeof payload.continuityNotes === "string"
              ? payload.continuityNotes
              : undefined,
          layoutPreference:
            payload.layoutPreference === "single" ||
            payload.layoutPreference === "comic" ||
            payload.layoutPreference === "auto"
              ? payload.layoutPreference
              : undefined,
          stylePreset:
            typeof payload.stylePreset === "string"
              ? payload.stylePreset
              : undefined,
          negativePrompt:
            typeof payload.negativePrompt === "string"
              ? payload.negativePrompt
              : undefined,
        };
      }
    }
  }
  return undefined;
}

function extractImageState(
  context: unknown,
): ImageState {
  if (
    context !== null &&
    context !== undefined &&
    typeof context === "object" &&
    "state" in context
  ) {
    const stateObj = (context as Record<string, unknown>).state;
    if (
      stateObj !== null &&
      stateObj !== undefined &&
      typeof stateObj === "object" &&
      "core-image" in stateObj
    ) {
      const imageState = (stateObj as Record<string, unknown>)["core-image"];
      if (
        imageState !== null &&
        imageState !== undefined &&
        typeof imageState === "object" &&
        "recentImages" in imageState
      ) {
        return imageState as unknown as ImageState;
      }
    }
  }
  return EMPTY_STATE;
}

/**
 * Parse the LLM response to extract enhanced prompt and multi-scene flag.
 */
export function parseEnhancedResponse(
  original: string,
  llmResponse: string,
): EnhancedPrompt {
  const trimmed = llmResponse.trim();
  const isMultiFromLlm = trimmed.startsWith("[MULTI-SCENE]");
  const enhanced = isMultiFromLlm
    ? trimmed.replace(/^\[MULTI-SCENE\]\s*/i, "").trim()
    : trimmed;

  const heuristic = detectMultiScene(original);
  const isMultiScene = isMultiFromLlm || heuristic.isMultiScene;

  return {
    original,
    enhanced,
    isMultiScene,
    multiSceneReason: isMultiFromLlm
      ? "llm-detected"
      : heuristic.reason,
  };
}

// ── Runtime Handler ─────────────────────────────────────────────

/**
 * Custom runtime handler for the 2-step image generation flow.
 *
 * Step 1: Use LLM to enhance the image generation prompt.
 * Step 2: Return proposals with the enhanced prompt for downstream use.
 *
 * Note: Actual image generation (calling an image model) would require
 * image provider binding, which is not yet fully implemented in the kernel.
 * For now, the handler returns the enhanced prompt as a ui.render proposal.
 */
export const imageRuntimeHandler: RuntimeHandler = async (
  ctx: RuntimeHandlerContext,
): Promise<RuntimeHandlerResult> => {
  const request = extractImageRequest(ctx.context);
  if (!request) {
    return {
      proposals: [],
    };
  }

  const currentState = extractImageState(ctx.context);
  const style = request.stylePreset ?? "cinematic";
  const imageId = crypto.randomUUID();
  const now = new Date().toISOString();

  // Step 1: Build enhancement prompt and call LLM
  const systemPrompt = buildEnhancePrompt(request);

  let enhancedPrompt: EnhancedPrompt;

  if (ctx.generateText) {
    const llmResponse = await ctx.generateText(systemPrompt);
    enhancedPrompt = parseEnhancedResponse(request.scenePrompt, llmResponse);
  } else {
    // Fallback: use heuristic detection without LLM enhancement
    const heuristic = detectMultiScene(request.scenePrompt);
    enhancedPrompt = {
      original: request.scenePrompt,
      enhanced: request.scenePrompt,
      isMultiScene: heuristic.isMultiScene,
      multiSceneReason: heuristic.reason,
    };
  }

  // Build image result
  const imageResult: ImageResult = {
    imageId,
    prompt: enhancedPrompt,
    status: "ready",
    stylePreset: style,
    createdAt: now,
  };

  // Update state (immutable)
  const newState = addImageResult(currentState, imageResult);

  return {
    proposals: [
      {
        kind: "state.patch",
        payload: {
          scope: "core-image",
          patch: {
            recentImages: newState.recentImages,
          },
        },
      },
      {
        kind: "ui.render",
        payload: {
          type: "story_image",
          data: {
            imageId,
            status: imageResult.status,
            originalPrompt: enhancedPrompt.original,
            enhancedPrompt: enhancedPrompt.enhanced,
            isMultiScene: enhancedPrompt.isMultiScene,
            stylePreset: style,
          },
        },
      },
    ],
  };
};
