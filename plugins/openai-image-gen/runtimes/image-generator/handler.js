/**
 * @covel/plugin-openai-image-gen — image-generator handler
 *
 * Triggered by `openai-image.generate.requested` from the sibling
 * `prompt-generator` agent. Generation goes through the framework's unified
 * `ctx.images.generate()` pipeline: the kernel picks the wire from the
 * resolved slot (`modelPresetId` → `[covel.<slot>]` in `~/.covel/llm.toml`),
 * handles the HTTP call + SSRF guard + response parsing + promptHash dedup,
 * and persists bytes into MediaStore. This handler only extracts the prompt,
 * maps userSettings, and turns the returned `MediaRef[]` into pluginData
 * records + `asset.generate` proposals.
 *
 * Switching providers is still a pure llm.toml edit — no plugin code
 * changes — but the wire implementation itself now lives in the framework
 * (`@covel/ai-provider` image wires), not in this plugin.
 *
 * Execution mode: `background` — the framework writes a `_jobs/<jobId>`
 * pending record before invoking this handler. The right-panel gallery
 * subscribes to `plugin-data.changed` SSE on the `images` namespace and
 * re-renders when commit lands.
 */

const PROMPT_RUNTIME_ID = "openai-image-gen/prompt-generator";
const TRIGGER_TOPIC = "openai-image.generate.requested";
const IMAGES_NAMESPACE = "images";
const DEFAULT_PRESET_ID = "openai-image";

/**
 * Pull the prompt off the trigger event, falling back to manualPayload so
 * direct plugin-rpc invocations still work. (FunctionHandlerContext has no
 * completedResults — the event and the manual payload are the only sources.)
 *
 * @param {*} ctx
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
          composition:
            typeof d.composition === "string" ? d.composition : "single-scene",
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
      composition:
        typeof manual.composition === "string"
          ? manual.composition
          : "single-scene",
    };
  }

  return null;
}

function normalizeImageSize(value) {
  // OpenAI Images API expects lowercase "1024x1024". The UI/help text may
  // contain the common DashScope-style "1024*1024"; normalize it so users do
  // not have to remember which provider wants which separator.
  return String(value ?? "1024x1024")
    .trim()
    .replace("*", "x")
    .toLowerCase();
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
        "No image prompt found in ctx.triggerEvent or ctx.manualPayload. Did prompt-generator emit events[0].data.prompt with topic openai-image.generate.requested?",
    };
  }

  const { prompt, promptMode, composition } = extracted;

  const settings =
    /** @type {Record<string, unknown> | undefined} */ (userSettings) ?? {};
  const presetId =
    typeof settings.modelPresetId === "string" &&
    settings.modelPresetId.trim().length > 0
      ? settings.modelPresetId.trim()
      : DEFAULT_PRESET_ID;
  const imageSize = normalizeImageSize(
    typeof settings.imageSize === "string" &&
      settings.imageSize.trim().length > 0
      ? settings.imageSize.trim()
      : "1024x1024",
  );
  const n =
    typeof settings.n === "number" &&
    Number.isFinite(settings.n) &&
    settings.n >= 1
      ? Math.floor(settings.n)
      : 1;
  const requestTimeoutMs =
    typeof settings.requestTimeoutMs === "number" &&
    Number.isFinite(settings.requestTimeoutMs) &&
    settings.requestTimeoutMs > 0
      ? Math.floor(settings.requestTimeoutMs)
      : 300000;
  const quality =
    typeof settings.quality === "string" ? settings.quality.trim() : "";
  const style = typeof settings.style === "string" ? settings.style.trim() : "";
  // Style has no dedicated wire parameter in ctx.images.generate — fold it
  // into the prompt text, same as any other free-form prompt embellishment.
  const finalPrompt = style.length > 0 ? `${prompt}, style: ${style}` : prompt;

  const imageId = `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = new Date().toISOString();

  const baseRecord = {
    imageId,
    prompt: finalPrompt,
    promptMode,
    composition,
    turnId,
    presetId,
    imageSize,
    n,
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
    requestTimeoutMs,
  });

  try {
    const { refs, warnings, cached } = await images.generate({
      presetId,
      prompt: finalPrompt,
      size: imageSize,
      n,
      quality: quality || undefined,
      signal: AbortSignal.timeout(requestTimeoutMs),
      metadata: { source: "openai-image-gen", turnId },
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
        prompt: finalPrompt,
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
      prompt: finalPrompt,
      promptMode,
      composition,
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
