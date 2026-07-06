/**
 * ctx.speech pipeline — unified speech synthesis (TTS) and transcription
 * (STT) for function runtimes.
 *
 * Mirrors runtime-images-context.ts: wraps the low-level
 * `PluginRuntimeGateway.synthesizeSpeech()` (raw bytes, no persistence)
 * with promptHash-based dedup plus MediaStore persistence so handlers get
 * `MediaRef`s back. `transcribe()` has no dedup — its output is plain text
 * returned directly to the handler, nothing is persisted.
 */

import { createHash } from "node:crypto";
import type { MediaRef } from "@covel/shared";
import type { MediaStore } from "@covel/store";
import type {
  FunctionHandlerContext,
  PluginRuntimeGateway,
  SpeechContext,
  SpeechGenerateInput,
  SpeechGenerateOutput,
  SpeechTranscribeInput,
} from "@covel/plugin-loader";

// Same structural workaround as runtime-images-context.ts.
type MediaContext = NonNullable<FunctionHandlerContext["media"]>;

/** Deterministic key over synthesis params — identical calls dedupe. */
function promptHashOf(input: SpeechGenerateInput): string {
  const canonical = JSON.stringify([
    input.presetId ?? "",
    input.text,
    input.voice ?? "",
    input.format ?? "",
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

function isMediaRef(audio: SpeechTranscribeInput["audio"]): audio is MediaRef {
  return "id" in audio;
}

interface CreateRuntimeSpeechContextOptions {
  readonly sessionId: string;
  readonly pluginId: string;
}

export function createRuntimeSpeechContext(
  gateway: Required<
    Pick<PluginRuntimeGateway, "synthesizeSpeech" | "transcribeAudio">
  >,
  mediaStore: Pick<MediaStore, "listByMetadata">,
  media: Pick<MediaContext, "put" | "get">,
  options: CreateRuntimeSpeechContextOptions,
): SpeechContext {
  const { sessionId, pluginId } = options;
  return {
    async generate(input: SpeechGenerateInput): Promise<SpeechGenerateOutput> {
      const promptHash = promptHashOf(input);

      // Framework-injected keys are spread last so plugin-supplied
      // `metadata` can never override them. Same write/read contract as
      // ctx.images: cache hits stamp THIS call's metadata onto the refs.
      const meta = { ...input.metadata, pluginId, promptHash };

      const existing = await mediaStore.listByMetadata(sessionId, {
        promptHash,
        pluginId,
      });
      if (existing.length >= 1) {
        const asset = existing[0]!;
        return {
          refs: [{ id: asset.id, mime: asset.mime, size: asset.size, meta }],
          warnings: [],
          cached: true,
        };
      }

      const result = await gateway.synthesizeSpeech({
        presetId: input.presetId,
        text: input.text,
        voice: input.voice,
        format: input.format,
        signal: input.signal,
      });

      const ref = await media.put(
        result.audio.data,
        result.audio.mimeType,
        meta,
      );
      return { refs: [ref], warnings: result.warnings, cached: false };
    },

    async transcribe(input: SpeechTranscribeInput) {
      let audio: { data: Uint8Array; mimeType: string; fileName?: string };
      if (isMediaRef(input.audio)) {
        const blob = await media.get(input.audio);
        const data =
          blob instanceof Uint8Array
            ? blob
            : new Uint8Array(await blob.arrayBuffer());
        audio = { data, mimeType: input.audio.mime };
      } else {
        audio = input.audio;
      }

      const result = await gateway.transcribeAudio({
        presetId: input.presetId,
        audio,
        signal: input.signal,
      });
      return { text: result.text, warnings: result.warnings };
    },
  };
}
