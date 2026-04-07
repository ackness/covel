import type {
  RuntimeHandler,
  RuntimeHandlerContext,
  RuntimeHandlerResult,
} from "@covel/plugin-runtime";
import {
  buildEnhancePromptEn,
  buildEnhancePromptZh,
  detectMultiScene,
  addImageResult,
  resolvePromptLanguage,
  extractWorldContext,
  extractCharacterContext,
  EMPTY_STATE,
  DEFAULT_SETTINGS,
  type ImageRequest,
  type EnhancedPrompt,
  type ImageResult,
  type ImageState,
  type ImageSettings,
} from "./image-logic.js";

// ── Context Extraction Helpers ───────────────────────────────────

function extractFromEvent<T>(
  context: unknown,
  eventType: string,
  field?: string,
): T | undefined {
  if (!context || typeof context !== "object") return undefined;
  const event = (context as Record<string, unknown>).event;
  if (!event || typeof event !== "object") return undefined;
  const ev = event as Record<string, unknown>;
  if (ev.type !== eventType) return undefined;
  const payload =
    ev.payload && typeof ev.payload === "object"
      ? (ev.payload as Record<string, unknown>)
      : undefined;
  if (field) {
    return (ev[field] ?? payload?.[field]) as T | undefined;
  }
  return ({ ...payload, ...ev } as unknown) as T;
}

function extractImageState(context: unknown): ImageState {
  if (!context || typeof context !== "object") return EMPTY_STATE;
  const stateObj = (context as Record<string, unknown>).state;
  if (!stateObj || typeof stateObj !== "object") return EMPTY_STATE;
  const imageState = (stateObj as Record<string, unknown>)["core-image"];
  if (!imageState || typeof imageState !== "object") return EMPTY_STATE;
  const s = imageState as Partial<ImageState>;
  return {
    recentImages: Array.isArray(s.recentImages) ? s.recentImages : [],
    maxHistory: typeof s.maxHistory === "number" ? s.maxHistory : 20,
    settings: (s.settings as ImageSettings) ?? DEFAULT_SETTINGS,
  };
}

function normalizeImageSettings(value: unknown): ImageSettings {
  const raw = value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};

  return {
    style:
      raw.style === "anime" ||
      raw.style === "oil-painting" ||
      raw.style === "watercolor" ||
      raw.style === "pixel-art" ||
      raw.style === "photoreal"
        ? raw.style
        : "cinematic",
    multiPanel: raw.multiPanel === true,
    includeText: raw.includeText === true,
    promptLanguage:
      raw.promptLanguage === "zh" || raw.promptLanguage === "en"
        ? raw.promptLanguage
        : "auto",
  };
}

// ── Shared Helpers ───────────────────────────────────────────────

/**
 * Parse the LLM response to extract enhanced prompt and multi-scene flag.
 */
export function parseEnhancedResponse(
  original: string,
  llmResponse: string,
): EnhancedPrompt {
  const trimmed = llmResponse.trim();
  const isMultiFromLlm = trimmed.toLowerCase().startsWith("[multi-scene]");
  const enhanced = isMultiFromLlm
    ? trimmed.replace(/^\[MULTI-SCENE\]\s*/i, "").trim()
    : trimmed;

  const heuristic = detectMultiScene(original);
  const isMultiScene = isMultiFromLlm || heuristic.isMultiScene;

  return {
    original,
    enhanced,
    isMultiScene,
    multiSceneReason: isMultiFromLlm ? "llm-detected" : heuristic.reason,
  };
}

// ── Runtime 1: promptEnhancerHandler ─────────────────────────────
//
// Triggered by: image.generation.requested
// Provider: slot.plugin (text model)
// Action:
//   1. Read session state (settings, recent images)
//   2. Extract world context + character context
//   3. Call ctx.generateText with locale-appropriate prompt template
//   4. Emit image.generation.ready with enhanced prompt

export const promptEnhancerHandler: RuntimeHandler = async (
  ctx: RuntimeHandlerContext,
): Promise<RuntimeHandlerResult> => {
  const request = extractFromEvent<ImageRequest>(
    ctx.context,
    "image.generation.requested",
  );

  if (!request || typeof (request as Record<string, unknown>).scenePrompt !== "string") {
    return { proposals: [] };
  }

  const req = request as unknown as Record<string, unknown>;
  const imageRequest: ImageRequest = {
    storyBackground: String(req.storyBackground ?? ""),
    scenePrompt: String(req.scenePrompt ?? ""),
    continuityNotes: req.continuityNotes ? String(req.continuityNotes) : undefined,
    layoutPreference: req.layoutPreference as ImageRequest["layoutPreference"],
    stylePreset: req.stylePreset ? String(req.stylePreset) : undefined,
    negativePrompt: req.negativePrompt ? String(req.negativePrompt) : undefined,
  };

  const currentState = extractImageState(ctx.context);
  const settings: ImageSettings = currentState.settings;
  const style = settings.style ?? imageRequest.stylePreset ?? "cinematic";

  // Extract world + character context from the full runtime context
  const worldContext = extractWorldContext(ctx.context);
  const characterContext = extractCharacterContext(ctx.context);

  // Resolve prompt language and build enhancement prompt
  const lang = resolvePromptLanguage(settings, ctx.locale);
  const systemPrompt = lang === "zh"
    ? buildEnhancePromptZh(imageRequest, worldContext, characterContext, settings)
    : buildEnhancePromptEn(imageRequest, worldContext, characterContext, settings);

  // Step 1: LLM enhances the prompt
  let enhancedPrompt: EnhancedPrompt;
  if (ctx.generateText) {
    const llmResponse = await ctx.generateText(systemPrompt);
    enhancedPrompt = parseEnhancedResponse(imageRequest.scenePrompt, llmResponse);
  } else {
    const heuristic = detectMultiScene(imageRequest.scenePrompt);
    enhancedPrompt = {
      original: imageRequest.scenePrompt,
      enhanced: imageRequest.scenePrompt,
      isMultiScene: heuristic.isMultiScene,
      multiSceneReason: heuristic.reason,
    };
  }

  // Find the most recent image with a URL as reference (visual continuity)
  const referenceUrl = currentState.recentImages.find((img) => img.imageUrl)?.imageUrl;

  return {
    proposals: [
      {
        kind: "event.emit",
        payload: {
          type: "image.generation.ready",
          payload: {
            enhancedPrompt: enhancedPrompt.enhanced,
            originalPrompt: enhancedPrompt.original,
            isMultiScene: enhancedPrompt.isMultiScene,
            style,
            settings,
            ...(referenceUrl ? { referenceUrl } : {}),
            sourceMessageId: extractFromEvent<string>(ctx.context, "image.generation.requested", "sourceMessageId"),
          },
        },
      },
    ],
  };
};

// ── Runtime 2: imageGeneratorHandler ─────────────────────────────
//
// Triggered by: image.generation.ready
// Provider: slot.image (image generation model)
// Action:
//   1. Read enhanced prompt and settings from event
//   2. Call ctx.generateImage with the prompt + reference image
//   3. Emit ui.render (story_image) + state.patch (recentImages)

export const imageGeneratorHandler: RuntimeHandler = async (
  ctx: RuntimeHandlerContext,
): Promise<RuntimeHandlerResult> => {
  const eventPayload = extractFromEvent<Record<string, unknown>>(
    ctx.context,
    "image.generation.ready",
  );

  if (!eventPayload) {
    return { proposals: [] };
  }

  const enhancedPrompt = String(eventPayload.enhancedPrompt ?? "");
  const originalPrompt = String(eventPayload.originalPrompt ?? enhancedPrompt);
  const style = String(eventPayload.style ?? "cinematic");
  const isMultiScene = Boolean(eventPayload.isMultiScene);
  const referenceUrl = typeof eventPayload.referenceUrl === "string"
    ? eventPayload.referenceUrl
    : undefined;
  const settings = (eventPayload.settings as ImageSettings) ?? DEFAULT_SETTINGS;

  const imageId = crypto.randomUUID();
  const now = new Date().toISOString();

  const currentState = extractImageState(ctx.context);

  // Keep provider metadata minimal here. Slot-level imageApi is injected by the
  // kernel helper, while prompt language/layout decisions are already embedded
  // in the enhanced prompt text.
  const providerRequestMetadata: Record<string, unknown> = { n: 1, watermark: false };

  let imageUrl: string | undefined;
  let errorMsg: string | undefined;

  if (!ctx.generateImage) {
    errorMsg = "Image generation not available: no image slot configured";
  } else {
    try {
      const result = await ctx.generateImage(enhancedPrompt, {
        referenceUrl,
        providerRequestMetadata,
      });
      imageUrl = result.url;
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
    }
  }

  const imageResult: ImageResult = {
    imageId,
    prompt: {
      original: originalPrompt,
      enhanced: enhancedPrompt,
      isMultiScene,
    },
    status: imageUrl ? "ready" : "error",
    imageUrl,
    error: errorMsg,
    stylePreset: style,
    createdAt: now,
  };

  const newState = addImageResult(currentState, imageResult);

  return {
    proposals: [
      {
        kind: "state.patch",
        payload: {
          "core-image": {
            recentImages: newState.recentImages,
          },
        },
      },
      {
        kind: "ui.render",
        payload: {
          type: "story_image",
          content: {
            imageId,
            status: imageResult.status,
            originalPrompt,
            enhancedPrompt,
            isMultiScene,
            stylePreset: style,
            imageUrl,
            error: errorMsg,
          },
        },
      },
    ],
  };
};

export const settingsUpdaterHandler: RuntimeHandler = async (
  ctx: RuntimeHandlerContext,
): Promise<RuntimeHandlerResult> => {
  const eventPayload = extractFromEvent<Record<string, unknown>>(
    ctx.context,
    "image.settings.updated",
  );

  if (!eventPayload) {
    return { proposals: [] };
  }

  return {
    proposals: [
      {
        kind: "state.patch",
        payload: {
          "core-image": {
            settings: normalizeImageSettings(eventPayload.settings),
          },
        },
      },
    ],
  };
};

export const imageRuntimeHandler: RuntimeHandler = async (
  ctx: RuntimeHandlerContext,
): Promise<RuntimeHandlerResult> => {
  const enhanced = await promptEnhancerHandler(ctx);
  const emitted = enhanced.proposals.find((proposal) => proposal.kind === "event.emit");
  if (!emitted) {
    return { proposals: [] };
  }

  const eventEnvelope = emitted.payload as Record<string, unknown>;
  const eventType = typeof eventEnvelope.type === "string" ? eventEnvelope.type : "";
  const eventPayload =
    eventEnvelope.payload && typeof eventEnvelope.payload === "object"
      ? (eventEnvelope.payload as Record<string, unknown>)
      : {};

  if (eventType !== "image.generation.ready") {
    return { proposals: [] };
  }

  const nextContext = {
    ...(ctx.context && typeof ctx.context === "object"
      ? (ctx.context as Record<string, unknown>)
      : {}),
    event: {
      type: eventType,
      ...eventPayload,
    },
  };

  return imageGeneratorHandler({
    ...ctx,
    context: nextContext,
  });
};
