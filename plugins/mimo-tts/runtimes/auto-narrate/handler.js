/**
 * mimo-tts/auto-narrate — auto-trigger handler.
 *
 * Runs in the post-turn stage once the active narrative engine has succeeded
 * (gated by `needs: capability narrative-engine`). Pulls `narrativeOutput`
 * from the `inputs.narrative` binding and hands it to the framework speech
 * pipeline `ctx.speech.generate()` — slot resolution, the MiMo wire (see
 * ../../lib/wires.js), MediaStore persistence and promptHash dedup all
 * happen framework-side. This handler assembles the `tracks` record the
 * right-panel Tab binds against, and — every turn, even with auto synthesis
 * disabled — the `message`-namespace surface record that anchors the
 * manual-narrate Speak button under the turn's story message (the message
 * surface only renders when this namespace holds a record for the turn; the
 * button reads `/turnId` + `/text` from it as its invoke payload).
 *
 * Returns `assetGenerations: [{ ref, modality: 'audio', meta }]` — the key
 * the kernel's normalizeOutput collects into `asset.generate` proposals so
 * the new asset fans out through trace + SSE + render pipelines.
 */

import {
  pickNarratorText,
  persistTrack,
  recordFailure,
} from "../../lib/mimo-tts.js";

const TRACKS_NAMESPACE = "tracks";
const MESSAGE_NAMESPACE = "message";
const DEFAULT_PRESET_ID = "mimo-tts";

export default async function autoNarrateHandler(ctx) {
  const { turnId, speech, gateway, userSettings, pluginData, logger } = ctx;

  const settings =
    /** @type {Record<string, unknown> | undefined} */ (userSettings) ?? {};

  const text = pickNarratorText(ctx);
  if (!text) {
    return {
      status: "skipped",
      reason: "narrator produced no narrativeOutput",
    };
  }

  // Speak-button surface for this turn's story message. Keyed by turnId so
  // the plugin-message layer anchors the button under the right message; the
  // button's invokeRuntime payload reads /turnId + /text from this record.
  const messageEntry = {
    namespace: MESSAGE_NAMESPACE,
    key: turnId,
    value: { turnId, text },
  };

  if (settings.enabled === false) {
    // Auto synthesis is off, but the turn still gets its Speak button —
    // committing the surface record IS this run's (successful) work. Checked
    // before the speech-pipeline probe: the surface needs no speech at all.
    return {
      autoSynthesis: "disabled-by-user-setting",
      pluginData: [messageEntry],
    };
  }

  if (!speech || typeof speech.generate !== "function") {
    return {
      status: "failed",
      error:
        "ctx.speech is unavailable. Upgrade @covel/server / @covel/runtime to a build with the unified speech pipeline.",
    };
  }

  const presetId =
    typeof settings.modelPresetId === "string" &&
    settings.modelPresetId.trim().length > 0
      ? settings.modelPresetId.trim()
      : DEFAULT_PRESET_ID;
  const voice =
    typeof settings.voice === "string" && settings.voice.length > 0
      ? settings.voice
      : "mimo_default";
  const format = settings.format === "wav" ? "wav" : "mp3";
  const maxChars = positiveInt(settings.maxChars, 1200);
  const timeoutMs = positiveInt(settings.requestTimeoutMs, 60_000);

  const cleanText =
    text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
  // Display-only: the slot decides the actual model; look it up for the record.
  const model =
    gateway?.resolveSlot?.({ presetId, fallbackTag: "speech" })?.model ??
    presetId;
  const trackId = `tts-auto-${turnId}`;
  const startedAt = new Date().toISOString();

  const baseRecord = {
    trackId,
    turnId,
    status: "pending",
    text: cleanText,
    textLen: cleanText.length,
    model,
    voice,
    format,
    triggeredBy: "auto",
    presetId,
    startedAt,
  };
  await logger?.info?.("mimo-tts.started", {
    trackId,
    turnId,
    triggeredBy: "auto",
    presetId,
    voice,
    format,
  });

  try {
    const { refs, cached } = await speech.generate({
      presetId,
      text: cleanText,
      voice,
      format,
      metadata: {
        plugin: "mimo-tts",
        turnId,
        model,
        voice,
        format,
        triggeredBy: "auto",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ref = refs[0];
    if (!ref) throw new Error("speech provider returned no usable media");

    const { record, asset } = await persistTrack({
      pluginData,
      namespace: TRACKS_NAMESPACE,
      trackId,
      turnId,
      text: cleanText,
      model,
      voice,
      format,
      ref,
      cached,
      triggeredBy: "auto",
      startedAt,
      logger,
    });

    return {
      trackId,
      status: "done",
      ref: record.ref,
      pluginData: [
        { namespace: TRACKS_NAMESPACE, key: trackId, value: record },
        messageEntry,
      ],
      assetGenerations: [asset],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failure = await recordFailure({
      pluginData,
      namespace: TRACKS_NAMESPACE,
      trackId,
      base: baseRecord,
      message,
      logger,
    });
    // The Speak button must still appear for this turn so the player can
    // retry by hand. Written directly (like the failure record itself):
    // a failed result's returned pluginData is not committed.
    await pluginData?.set?.(messageEntry.namespace, messageEntry.key, {
      ...messageEntry.value,
    });
    return failure;
  }
}

function positiveInt(value, fallback) {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : fallback;
}
