import {
  GENERATED_NS,
  REGISTRY_KEY,
  SCENES_NS,
  STAGE_KEY,
  STAGE_NS,
  resolveMedia,
  sourceLabelFor,
} from "../../lib/stage-data.js";

const SCENE_KIND = "scene-background";
// Scene backgrounds are landscape by convention (A-spec) — the registry
// carries no per-scene size, so this is fixed here.
const SCENE_SIZE = "1536x1024";
const REQUEST_TIMEOUT_MS = 300_000;

/**
 * Generate a missing scene background via the framework image pipeline.
 * Triggered by `scene-stage.generate.requested` (the resolver's internal
 * signal). Updates the `generated` session index and, if `stage/current`
 * is still pointing at this scene, refreshes it from "pending" to
 * "session".
 *
 * @param {import('@covel/plugin-loader').FunctionHandlerContext} ctx
 */
export default async function handler(ctx) {
  const evt = ctx.triggerEvent;
  const data = evt?.data ?? {};
  const sceneId = typeof data.sceneId === "string" ? data.sceneId : "";
  const location = typeof data.location === "string" ? data.location : "";
  const variant = data.variant === "night" ? "night" : "day";
  if (!evt || !sceneId || !location) {
    return {
      status: "skipped",
      reason: "no usable generate-requested payload",
    };
  }

  if (!ctx.images) {
    await ctx.logger?.error?.("scene-stage.background-gen.no-images-context", {
      sceneId,
      variant,
    });
    return {
      status: "failed",
      error: "ctx.images is unavailable",
    };
  }

  const existing = ctx.pluginData
    ? await ctx.pluginData.get(GENERATED_NS, sceneId)
    : null;

  // Already generated this scene+variant — skip the (billed) image call so a
  // repeat generate.requested (e.g. visualHint drift) can't re-charge for art
  // we already have. Still refresh the stage in case it lags the index.
  const cachedRef = existing?.[variant];
  if (cachedRef && typeof cachedRef === "object") {
    await refreshStageIfCurrent(
      ctx,
      sceneId,
      existing.day ?? null,
      existing.night ?? null,
    );
    return { status: "skipped", reason: "variant already generated" };
  }

  const registry = ctx.pluginData
    ? await ctx.pluginData.get(SCENES_NS, REGISTRY_KEY)
    : null;
  const style =
    registry && typeof registry.style === "object" && registry.style !== null
      ? registry.style
      : {};
  const subject =
    typeof data.visualHint === "string" && data.visualHint.trim()
      ? data.visualHint.trim()
      : location;
  const prefix = typeof style.prefix === "string" ? style.prefix : "";
  const suffix = typeof style.suffix === "string" ? style.suffix : "";
  const nightSuffix =
    variant === "night" && typeof style.nightSuffix === "string"
      ? style.nightSuffix
      : "";
  const prompt = `${prefix}${subject}${suffix}${nightSuffix}`;

  let ref;
  try {
    const { refs } = await ctx.images.generate({
      prompt,
      size: SCENE_SIZE,
      n: 1,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      metadata: { kind: SCENE_KIND, sceneId, variant },
    });
    if (!refs || refs.length === 0) {
      throw new Error("ctx.images.generate returned no refs");
    }
    ref = refs[0];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ctx.logger?.error?.("scene-stage.background-gen.failed", {
      sceneId,
      variant,
      error: message,
    });
    return { status: "failed", error: message };
  }

  const generatedEntry = {
    sceneId,
    location,
    day: variant === "day" ? ref : (existing?.day ?? null),
    night: variant === "night" ? ref : (existing?.night ?? null),
    updatedAt: new Date().toISOString(),
  };
  await ctx.pluginData?.set(GENERATED_NS, sceneId, generatedEntry);

  await refreshStageIfCurrent(
    ctx,
    sceneId,
    generatedEntry.day,
    generatedEntry.night,
  );

  return {
    status: "done",
    assetGenerations: [
      { ref, modality: "image", meta: { kind: SCENE_KIND, sceneId, variant } },
    ],
  };
}

/**
 * When `stage/current` still points at this scene, refresh it from "pending"
 * to the freshly-known "session" art. No-op otherwise (the player has moved on).
 *
 * @param {import('@covel/plugin-loader').FunctionHandlerContext} ctx
 * @param {string} sceneId
 * @param {unknown} day
 * @param {unknown} night
 */
async function refreshStageIfCurrent(ctx, sceneId, day, night) {
  const previousStage = ctx.pluginData
    ? await ctx.pluginData.get(STAGE_NS, STAGE_KEY)
    : null;
  if (
    !previousStage ||
    typeof previousStage !== "object" ||
    previousStage.sceneId !== sceneId
  ) {
    return;
  }
  await ctx.pluginData.set(STAGE_NS, STAGE_KEY, {
    ...previousStage,
    source: "session",
    day,
    night,
    resolved: resolveMedia(previousStage.variant, day, night),
    sourceLabel: sourceLabelFor("session"),
    updatedAt: new Date().toISOString(),
  });
}
