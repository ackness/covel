/**
 * @covel/plugin-dashscope-image-gen — image-generator handler
 *
 * Triggered by the `image.generate.requested` event from the sibling
 * `prompt-generator` agent. Generation goes through the framework's unified
 * `ctx.images.generate()` pipeline: the kernel picks the wire from the
 * resolved slot (`modelPresetId` → `[covel.<slot>]` in `~/.covel/llm.toml`,
 * `providerRequestMetadata.imageWire = "dashscope-wan"`), handles the
 * DashScope wan2.x async task (submit + poll), the `x`→`*` size-separator
 * conversion, wan2.7-image* negative_prompt stripping (surfaced back as a
 * warning), single-image `n` clamping, the `X-DashScope-Async` header,
 * SSRF/redirect guarding, and OSS URL ingestion into the framework
 * MediaStore. This handler only extracts the prompt, maps userSettings,
 * and turns the returned `MediaRef[]` into pluginData records + `asset.
 * generate` proposals.
 *
 * Execution mode: `background` (declared in PLUGIN.md). The framework
 * writes a `_jobs/<jobId>` pending record before invoking this handler
 * and defers the call so the HTTP response flushes immediately. Right-
 * panel gallery subscribes to `plugin-data.changed` SSE on the `images`
 * namespace and re-renders when the commit lands.
 */

const TRIGGER_TOPIC = "image.generate.requested";
const IMAGES_NAMESPACE = "images";
const DEFAULT_PRESET_ID = "image";
const DEFAULT_REQUEST_TIMEOUT_MS = 300000;

/**
 * Pull the prompt off the trigger event, falling back to manualPayload so
 * direct plugin-rpc invocations still work. (FunctionHandlerContext has no
 * completedResults — the event and the manual payload are the only sources.)
 */
function extractPrompt(ctx) {
  const trigger = ctx.triggerEvent;
  if (
    trigger &&
    typeof trigger === "object" &&
    trigger.topic === TRIGGER_TOPIC
  ) {
    const data = trigger.data;
    if (data && typeof data === "object") {
      const d = /** @type {Record<string, unknown>} */ (data);
      if (typeof d.prompt === "string" && d.prompt.length > 0) {
        return {
          prompt: d.prompt,
          promptMode: typeof d.promptMode === "string" ? d.promptMode : "text",
        };
      }
    }
  }

  const manual = ctx.manualPayload;
  if (manual && typeof manual.prompt === "string" && manual.prompt.length > 0) {
    return {
      prompt: manual.prompt,
      promptMode:
        typeof manual.promptMode === "string" ? manual.promptMode : "text",
    };
  }

  return null;
}

function stringSetting(value, fallback) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : fallback;
}

function positiveInt(value, fallback) {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) && num >= 1 ? Math.floor(num) : fallback;
}

function finitePositiveNumber(value, fallback) {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

function imageRecordKey(imageId, refs, idx) {
  return refs.length === 1 ? imageId : `${imageId}-${idx + 1}`;
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

/** @type {import('@covel/plugin-loader').FunctionHandler} */
export default async function imageGeneratorHandler(ctx) {
  const { turnId, images, userSettings, pluginData, logger } = ctx;

  if (!images) {
    return {
      status: "failed",
      error:
        "ctx.images is unavailable. This plugin requires the framework image pipeline: " +
        "an image-tagged slot in llm.toml plus a configured MediaStore. Upgrade " +
        '@covel/server / @covel/runtime and add a [covel.<slot>] block with tag = "image".',
    };
  }

  const extracted = extractPrompt(ctx);
  if (!extracted) {
    await logger?.warn?.("no-prompt-found", {
      hasTriggerEvent: !!ctx.triggerEvent,
    });
    return {
      status: "skipped",
      reason: "no-prompt-found",
      message:
        "No image prompt found in ctx.triggerEvent or ctx.manualPayload.",
    };
  }

  const { prompt, promptMode } = extracted;

  const settings =
    /** @type {Record<string, unknown> | undefined} */ (userSettings) ?? {};
  const presetId = stringSetting(settings.modelPresetId, DEFAULT_PRESET_ID);
  const imageSize = stringSetting(settings.imageSize, "1024x1024");
  const n = positiveInt(settings.n, 1);
  const requestTimeoutMs = finitePositiveNumber(
    settings.requestTimeoutMs,
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
  const quality = stringSetting(settings.quality, "low");
  const negativePromptSetting =
    typeof settings.negativePrompt === "string" ? settings.negativePrompt : "";

  const imageId = `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = new Date().toISOString();
  const baseRecord = {
    imageId,
    prompt,
    promptMode,
    turnId,
    presetId,
    imageSize,
    n,
    quality,
    requestTimeoutMs,
    startedAt,
  };

  // Pre-write a pending placeholder so the gallery can spin while we wait.
  await pluginData?.set(IMAGES_NAMESPACE, imageId, {
    ...baseRecord,
    status: "pending",
  });
  await logger?.info?.("image.generate.started", {
    imageId,
    presetId,
    imageSize,
    n,
    quality,
    requestTimeoutMs,
  });

  try {
    const { refs, warnings, cached } = await images.generate({
      presetId,
      prompt,
      negativePrompt: negativePromptSetting || undefined,
      size: imageSize,
      quality,
      n,
      signal: AbortSignal.timeout(requestTimeoutMs),
      metadata: { source: "dashscope-image-gen", turnId },
    });

    if (refs.length === 0) {
      return failureRecord(
        pluginData,
        logger,
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
    const record = imageRecords[0].value;
    const assets = refs.map((ref, imageIndex) => ({
      ref,
      modality: "image",
      meta: {
        prompt,
        imageSize,
        imageId,
        imageIndex,
        mime: ref.mime,
        byteSize: ref.size,
      },
    }));

    await logger?.info?.("image.generate.completed", {
      imageId,
      durationMs: record.durationMs,
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
    return failureRecord(pluginData, logger, baseRecord, errorMessage(err));
  }
}

/**
 * Build a uniform failure record + logger entry + handler return value so
 * every error path lands in the gallery as a `failed` card with a readable
 * message instead of a missing entry.
 */
async function failureRecord(
  pluginData,
  logger,
  baseRecord,
  message,
  completedAt,
) {
  const finishedAt = completedAt ?? new Date().toISOString();
  const record = {
    ...baseRecord,
    status: "failed",
    error: message,
    completedAt: finishedAt,
  };
  await pluginData?.set(IMAGES_NAMESPACE, baseRecord.imageId, record);
  await logger?.error?.("image.generate.failed", {
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
