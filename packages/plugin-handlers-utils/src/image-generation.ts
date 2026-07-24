/**
 * Shared core for event-follower image-generation handlers
 * (dashscope-image-gen / openai-image-gen).
 *
 * The whole trunk is provider-agnostic: extract the prompt from the trigger
 * event (manualPayload fallback), pre-write a pending gallery record, call
 * the framework pipeline `ctx.images.generate()`, fan the returned
 * `MediaRef[]` into per-image gallery records + `assetGenerations[]`, and
 * land every error path as a visible `failed` card. Per-plugin differences
 * (event topic, default preset, extra prompt fields, userSettings → request
 * mapping) come in through {@link ImageGenerationPluginConfig}.
 */

import { optionalString } from "./index.js";

/** The slice of FunctionHandlerContext this trunk reads. */
export interface ImageGenerationHandlerContext {
  readonly turnId?: string;
  readonly triggerEvent?: unknown;
  readonly manualPayload?: unknown;
  readonly userSettings?: unknown;
  readonly images?: {
    generate(request: Record<string, unknown>): Promise<{
      refs: ReadonlyArray<{ id: string; mime: string; size: number }>;
      warnings: readonly string[];
      cached: boolean;
    }>;
  };
  readonly pluginData?: {
    set(namespace: string, key: string, value: unknown): Promise<void>;
  };
  readonly logger?: {
    info?(event: string, data?: Record<string, unknown>): Promise<void> | void;
    warn?(event: string, data?: Record<string, unknown>): Promise<void> | void;
    error?(event: string, data?: Record<string, unknown>): Promise<void> | void;
  };
}

export interface ExtractedImagePrompt {
  readonly prompt: string;
  readonly promptMode: string;
  /** Values of `extraPromptFields`, keyed by field name (defaulted). */
  readonly extras: Readonly<Record<string, string>>;
}

/** What the per-plugin mapper turns userSettings + the extracted prompt into. */
export interface ImageGenerationRequestPlan {
  /** Final prompt (the mapper may embellish, e.g. fold a style suffix in). */
  readonly prompt: string;
  readonly presetId: string;
  readonly size: string;
  readonly n: number;
  readonly requestTimeoutMs: number;
  readonly quality?: string;
  readonly negativePrompt?: string;
  /** Extra fields persisted onto every gallery record (e.g. quality copy). */
  readonly recordFields?: Readonly<Record<string, unknown>>;
}

export interface ImageGenerationPluginConfig {
  /** Metadata `source` + logger identity, e.g. "dashscope-image-gen". */
  readonly source: string;
  readonly triggerTopic: string;
  /**
   * Prompt-payload fields beyond prompt/promptMode to carry through
   * (e.g. openai's `composition`), as `{ field: defaultValue }`.
   */
  readonly extraPromptFields?: Readonly<Record<string, string>>;
  /** userSettings + extracted prompt → concrete generate() request. */
  readonly planRequest: (
    settings: Readonly<Record<string, unknown>>,
    extracted: ExtractedImagePrompt,
  ) => ImageGenerationRequestPlan;
}

const IMAGES_NAMESPACE = "images";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readPromptPayload(
  payload: unknown,
  extraPromptFields: Readonly<Record<string, string>>,
): ExtractedImagePrompt | null {
  const rec = asRecord(payload);
  const prompt = rec ? optionalString(rec.prompt) : undefined;
  if (!rec || !prompt) return null;
  const extras: Record<string, string> = {};
  for (const [field, fallback] of Object.entries(extraPromptFields)) {
    extras[field] = optionalString(rec[field]) ?? fallback;
  }
  return {
    prompt,
    promptMode: optionalString(rec.promptMode) ?? "text",
    extras,
  };
}

/**
 * Pull the prompt off the trigger event, falling back to manualPayload so
 * direct plugin-rpc invocations still work. (FunctionHandlerContext has no
 * completedResults — the event and the manual payload are the only sources.)
 */
export function extractImagePrompt(
  ctx: ImageGenerationHandlerContext,
  config: Pick<
    ImageGenerationPluginConfig,
    "triggerTopic" | "extraPromptFields"
  >,
): ExtractedImagePrompt | null {
  const extraFields = config.extraPromptFields ?? {};
  const trigger = asRecord(ctx.triggerEvent);
  if (trigger && trigger.topic === config.triggerTopic) {
    const fromEvent = readPromptPayload(trigger.data, extraFields);
    if (fromEvent) return fromEvent;
  }
  return readPromptPayload(ctx.manualPayload, extraFields);
}

function imageRecordKey(
  imageId: string,
  refs: readonly unknown[],
  idx: number,
): string {
  return refs.length === 1 ? imageId : `${imageId}-${idx + 1}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Uniform failure path: gallery record + logger entry + handler return value,
 * so every error lands as a visible `failed` card instead of a missing entry.
 */
async function failureRecord(
  ctx: ImageGenerationHandlerContext,
  baseRecord: Record<string, unknown> & { imageId: string },
  message: string,
): Promise<Record<string, unknown>> {
  const record = {
    ...baseRecord,
    status: "failed",
    error: message,
    completedAt: new Date().toISOString(),
  };
  await ctx.pluginData?.set(IMAGES_NAMESPACE, baseRecord.imageId, record);
  await ctx.logger?.error?.("image.generate.failed", {
    imageId: baseRecord.imageId,
    error: message,
  });
  return {
    imageId: baseRecord.imageId,
    status: "failed",
    error: message,
    prompt: baseRecord.prompt,
    promptMode: baseRecord.promptMode,
    pluginData: [
      { namespace: IMAGES_NAMESPACE, key: baseRecord.imageId, value: record },
    ],
  };
}

/**
 * Provider-agnostic image-generation trunk. Returns the handler result
 * object (success, skipped, or failed shape) — call it as the entire body
 * of a function-runtime handler.
 */
export async function runImageGeneration(
  ctx: ImageGenerationHandlerContext,
  config: ImageGenerationPluginConfig,
): Promise<Record<string, unknown>> {
  if (!ctx.images) {
    return {
      status: "failed",
      error:
        "ctx.images is unavailable. This plugin requires the framework image pipeline: " +
        "an image-tagged slot in llm.toml plus a configured MediaStore. Upgrade " +
        '@covel/server / @covel/runtime and add a [covel.<slot>] block with tag = "image".',
    };
  }

  const extracted = extractImagePrompt(ctx, config);
  if (!extracted) {
    await ctx.logger?.warn?.("no-prompt-found", {
      hasTriggerEvent: !!ctx.triggerEvent,
    });
    return {
      status: "skipped",
      reason: "no-prompt-found",
      message: `No image prompt found in ctx.triggerEvent or ctx.manualPayload. Did prompt-generator emit events[0].data.prompt with topic ${config.triggerTopic}?`,
    };
  }

  const settings = asRecord(ctx.userSettings) ?? {};
  const plan = config.planRequest(settings, extracted);
  const { prompt } = plan;
  const { promptMode, extras } = extracted;

  const imageId = `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = new Date().toISOString();
  const baseRecord = {
    imageId,
    prompt,
    promptMode,
    ...extras,
    turnId: ctx.turnId,
    presetId: plan.presetId,
    imageSize: plan.size,
    n: plan.n,
    requestTimeoutMs: plan.requestTimeoutMs,
    ...(plan.recordFields ?? {}),
    startedAt,
  };

  // Pre-write a pending placeholder so the gallery can spin while we wait.
  await ctx.pluginData?.set(IMAGES_NAMESPACE, imageId, {
    ...baseRecord,
    status: "pending",
  });
  await ctx.logger?.info?.("image.generate.started", {
    imageId,
    presetId: plan.presetId,
    imageSize: plan.size,
    n: plan.n,
    requestTimeoutMs: plan.requestTimeoutMs,
    ...(plan.quality !== undefined ? { quality: plan.quality } : {}),
  });

  try {
    const { refs, warnings, cached } = await ctx.images.generate({
      presetId: plan.presetId,
      prompt,
      size: plan.size,
      n: plan.n,
      quality: plan.quality || undefined,
      negativePrompt: plan.negativePrompt || undefined,
      signal: AbortSignal.timeout(plan.requestTimeoutMs),
      metadata: { source: config.source, turnId: ctx.turnId },
    });

    if (refs.length === 0) {
      return failureRecord(
        ctx,
        baseRecord,
        `Provider returned no images.${warnings.length > 0 ? ` Warnings: ${warnings.join("; ")}` : ""}`,
      );
    }

    const completedAt = new Date().toISOString();
    const imageRecords = refs.map((ref, idx) => ({
      key: imageRecordKey(imageId, refs, idx),
      value: {
        ...baseRecord,
        imageId: imageRecordKey(imageId, refs, idx),
        batchId: imageId,
        imageIndex: idx,
        imageCount: refs.length,
        status: "done",
        ref,
        ...(cached ? { cached: true } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
        completedAt,
        durationMs: Date.parse(completedAt) - Date.parse(startedAt),
      },
    }));
    const assets = refs.map((ref, imageIndex) => ({
      ref,
      modality: "image",
      meta: {
        prompt,
        imageSize: plan.size,
        imageId,
        imageIndex,
        mime: ref.mime,
        byteSize: ref.size,
      },
    }));

    await ctx.logger?.info?.("image.generate.completed", {
      imageId,
      durationMs: imageRecords[0]!.value.durationMs,
      imageCount: refs.length,
      cached,
      ...(warnings.length > 0 ? { warnings } : {}),
    });

    return {
      imageId,
      status: "done",
      ref: refs[0],
      ...(refs.length > 1 ? { refs } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(cached ? { cached: true } : {}),
      prompt,
      promptMode,
      ...extras,
      pluginData: imageRecords.map((entry) => ({
        namespace: IMAGES_NAMESPACE,
        key: entry.key,
        value: entry.value,
      })),
      // Kernel `normalizeOutput()` collects `output.assetGenerations[]` and
      // turns each into a `Proposal{ type: 'asset.generate' }`. Per-image
      // entry so the gallery / SSE renders each image independently.
      assetGenerations: assets,
    };
  } catch (err) {
    return failureRecord(ctx, baseRecord, errorMessage(err));
  }
}
