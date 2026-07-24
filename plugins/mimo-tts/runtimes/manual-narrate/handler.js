/**
 * mimo-tts/manual-narrate — manual button handler.
 *
 * Triggered via POST /api/sessions/:id/plugin-rpc with payload:
 *   { runtimeId: 'mimo-tts/manual-narrate', payload: { turnId, text } }
 * built by the Speak button (ui/play-button.json), whose $state bindings
 * read turnId + text from the message-surface record auto-narrate writes
 * each turn. payload.text is REQUIRED: a manual activation resolves no
 * turn input bindings (`ctx.inputs` is always empty here), so there is no
 * narrative fallback to fall back to.
 *
 * Synthesis goes through the framework pipeline `ctx.speech.generate()`
 * (MiMo wire in ../../lib/wires.js; slot resolution, persistence and
 * promptHash dedup are framework-side — re-speaking the same paragraph
 * returns the cached track instead of re-billing).
 *
 * execution: background means the HTTP response flushes a `jobId`
 * immediately and this handler runs deferred. The right-panel Tab picks
 * up the new track via `plugin-data.changed` SSE.
 */

import { persistTrack, recordFailure } from "../../lib/mimo-tts.js";

const TRACKS_NAMESPACE = "tracks";
const DEFAULT_PRESET_ID = "mimo-tts";

export default async function manualNarrateHandler(ctx) {
  const {
    turnId,
    speech,
    gateway,
    userSettings,
    manualPayload,
    pluginData,
    logger,
  } = ctx;

  const settings =
    /** @type {Record<string, unknown> | undefined} */ (userSettings) ?? {};
  const payload =
    /** @type {Record<string, unknown> | undefined} */ (manualPayload) ?? {};

  if (!speech || typeof speech.generate !== "function") {
    return {
      status: "failed",
      error:
        "ctx.speech is unavailable. Upgrade @covel/server / @covel/runtime to a build with the unified speech pipeline.",
    };
  }

  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!text) {
    return {
      status: "skipped",
      reason:
        "payload.text is required — the Speak button passes the paragraph " +
        "text via its $state binding (manual activations carry no inputs)",
    };
  }

  const presetId =
    pickStringOverride(payload.modelPresetId, settings.modelPresetId) ??
    DEFAULT_PRESET_ID;
  const voice =
    pickStringOverride(payload.voice, settings.voice) ?? "mimo_default";
  const format = (payload.format ?? settings.format) === "wav" ? "wav" : "mp3";
  const maxChars = positiveInt(payload.maxChars ?? settings.maxChars, 1500);
  const timeoutMs = positiveInt(
    payload.requestTimeoutMs ?? settings.requestTimeoutMs,
    90_000,
  );

  const cleanText =
    text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
  // Display-only: the slot decides the actual model; look it up for the record.
  const model =
    gateway?.resolveSlot?.({ presetId, fallbackTag: "speech" })?.model ??
    presetId;
  const sourceTurnId =
    typeof payload.turnId === "string" && payload.turnId.length > 0
      ? payload.turnId
      : turnId;
  const trackId = `tts-manual-${sourceTurnId}-${Date.now().toString(36)}`;
  const startedAt = new Date().toISOString();

  const baseRecord = {
    trackId,
    turnId: sourceTurnId,
    status: "pending",
    text: cleanText,
    textLen: cleanText.length,
    model,
    voice,
    format,
    triggeredBy: "manual",
    presetId,
    startedAt,
  };
  await logger?.info?.("mimo-tts.started", {
    trackId,
    turnId: sourceTurnId,
    triggeredBy: "manual",
    presetId,
    model,
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
        turnId: sourceTurnId,
        model,
        voice,
        format,
        triggeredBy: "manual",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ref = refs[0];
    if (!ref) throw new Error("speech provider returned no usable media");

    const { record, asset } = await persistTrack({
      pluginData,
      namespace: TRACKS_NAMESPACE,
      trackId,
      turnId: sourceTurnId,
      text: cleanText,
      model,
      voice,
      format,
      ref,
      cached,
      triggeredBy: "manual",
      startedAt,
      logger,
    });

    return {
      trackId,
      status: "done",
      ref: record.ref,
      pluginData: [
        { namespace: TRACKS_NAMESPACE, key: trackId, value: record },
      ],
      assetGenerations: [asset],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return recordFailure({
      pluginData,
      namespace: TRACKS_NAMESPACE,
      trackId,
      base: baseRecord,
      message,
      logger,
    });
  }
}

function pickStringOverride(...candidates) {
  for (const cand of candidates) {
    if (typeof cand === "string" && cand.trim().length > 0) return cand.trim();
  }
  return undefined;
}

function positiveInt(value, fallback) {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : fallback;
}
