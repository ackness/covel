/**
 * @covel/plugin-mimo-tts — shared record/display helpers.
 *
 * The MiMo HTTP wire itself lives in ./wires.js and is registered into the
 * framework speech-wire registry via the PLUGIN.md `wires` field. Handlers
 * call `ctx.speech.generate()` (slot resolution, wire dispatch, MediaStore
 * persistence and promptHash dedup all happen in the framework); this
 * module only assembles the `tracks` plugin-data records the right-panel
 * Tab binds against.
 */

/**
 * Compute the human-friendly display fields the right-panel spec binds
 * against. Centralised here so auto / manual / failure paths agree.
 *
 * @param {{ turnId?: string, triggeredBy: 'auto'|'manual', text: string, byteSize?: number }} args
 */
export function deriveDisplayFields(args) {
  const { turnId, triggeredBy, text, byteSize } = args;
  return {
    turnLabel: shortTurnLabel(turnId),
    triggerLabel: triggeredBy === "auto" ? "AUTO" : "MANUAL",
    textPreview: previewLine(text),
    sizeLabel: typeof byteSize === "number" ? formatBytes(byteSize) : "",
  };
}

function shortTurnLabel(turnId) {
  if (!turnId) return "Turn ?";
  // Most turnIds are UUIDs or `turn-<n>` — keep the last 6 chars so the label
  // stays compact in the header row.
  const tail =
    turnId.length > 8 ? turnId.slice(-6) : turnId.replace(/^turn-/, "");
  return `Turn ${tail}`;
}

function previewLine(text) {
  // Audio Tab is a playlist — narrator content is already in the chat
  // stream, so we only need a short identifier line per turn (~40 chars).
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 40 ? `${oneLine.slice(0, 39)}…` : oneLine;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Pull the active narrative engine's narrativeOutput from the declared
 * `inputs.narrative` binding (`ctx.inputs.narrative`, an InputSlot whose
 * `value` is the post-`select` `/narrativeOutput`). Engine-agnostic: the
 * capability binding resolves to narrator (traditional) OR chat-mode-narrator
 * (dialogue), so this fires in both modes — unlike the old hardcoded
 * `completedResults.get('narrator')` read, which never matched in dialogue.
 * auto-narrate only: manual activations resolve no turn bindings, so
 * manual-narrate takes its text from the Speak button's payload instead.
 */
export function pickNarratorText(ctx) {
  const slot = ctx.inputs?.narrative;
  const value = slot && typeof slot === "object" ? slot.value : undefined;
  // The declared contract selects `/narrativeOutput` (a string); normalize
  // defensively in case a producer projects a `{ narrativeOutput|content }` object.
  const candidate =
    typeof value === "string"
      ? value
      : value && typeof value === "object"
        ? typeof value.narrativeOutput === "string"
          ? value.narrativeOutput
          : typeof value.content === "string"
            ? value.content
            : null
        : null;
  if (!candidate) return null;
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Persist the track record + build the `assetGenerations[]` entry (the kernel
 * collects that key into `asset.generate` proposals) for one turn-of-audio.
 * `ref` comes from `ctx.speech.generate()` — the bytes are already in the
 * MediaStore by the time this runs. Both runtimes write into the same
 * `tracks` namespace so the right-panel Tab is a single chronological list.
 *
 * @param {{
 *   pluginData: { set: (ns: string, key: string, value: unknown) => Promise<void> } | undefined,
 *   namespace: string,
 *   trackId: string,
 *   turnId: string,
 *   text: string,
 *   model: string,
 *   voice: string,
 *   format: string,
 *   ref: { id: string, mime: string, size: number },
 *   cached: boolean,
 *   triggeredBy: 'auto' | 'manual',
 *   startedAt: string,
 *   logger?: { info?: Function, error?: Function },
 * }} args
 */
export async function persistTrack(args) {
  const {
    pluginData,
    namespace,
    trackId,
    turnId,
    text,
    model,
    voice,
    format,
    ref,
    cached,
    triggeredBy,
    startedAt,
    logger,
  } = args;

  const completedAt = new Date().toISOString();
  const display = deriveDisplayFields({
    turnId,
    triggeredBy,
    text,
    byteSize: ref.size,
  });
  const value = {
    trackId,
    turnId,
    status: "done",
    text,
    textLen: text.length,
    model,
    voice,
    format,
    triggeredBy,
    startedAt,
    completedAt,
    durationMs: Date.parse(completedAt) - Date.parse(startedAt),
    ref,
    cached,
    autoPlay: triggeredBy === "auto" && !cached,
    ...display,
  };

  await pluginData?.set?.(namespace, trackId, value);
  await logger?.info?.("mimo-tts.completed", {
    trackId,
    turnId,
    triggeredBy,
    bytes: ref.size,
    cached,
    durationMs: value.durationMs,
  });

  return {
    record: value,
    asset: {
      ref,
      modality: "audio",
      meta: {
        plugin: "mimo-tts",
        turnId,
        model,
        voice,
        format,
        mime: ref.mime,
        byteSize: ref.size,
      },
    },
  };
}

/**
 * Common record + return-value shape for failure paths.
 */
export async function recordFailure({
  pluginData,
  namespace,
  trackId,
  base,
  message,
  logger,
}) {
  const completedAt = new Date().toISOString();
  const display = deriveDisplayFields({
    turnId: base?.turnId,
    triggeredBy: base?.triggeredBy ?? "auto",
    text: base?.text ?? "",
  });
  const value = {
    ...base,
    trackId,
    status: "failed",
    error: message,
    completedAt,
    ...display,
  };
  await pluginData?.set?.(namespace, trackId, value);
  await logger?.error?.("mimo-tts.failed", { trackId, error: message });
  return {
    trackId,
    status: "failed",
    error: message,
    pluginData: [{ namespace, key: trackId, value }],
  };
}
