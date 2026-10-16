/**
 * ctx.music pipeline — music generation for function runtimes.
 *
 * Mirrors runtime-speech-context.ts: wraps the low-level
 * `PluginRuntimeGateway.composeMusic()` (raw bytes, no persistence) with
 * promptHash-based dedup plus MediaStore persistence so handlers get
 * `MediaRef`s back. A piece costs far more than a spoken line, so the same
 * request from the same plugin in the same session is never paid for twice.
 */

import type { MediaStore } from "@covel/store";
import type {
  MediaContext,
  MusicContext,
  MusicGenerateInput,
  MusicGenerateOutput,
  PluginRuntimeGateway,
} from "@covel/shared/plugin-runtime";
import {
  mediaPromptHash,
  isSlotAvailable,
  cachedSingleRef,
  resolveTargetIdentity,
} from "./media-cache-key.js";

/**
 * Deterministic key over the model and the generation params — identical
 * calls dedupe, and a role bound to another model composes again.
 */
function promptHashOf(
  input: MusicGenerateInput,
  target: readonly unknown[] | null,
): string {
  return mediaPromptHash([
    target,
    input.presetId ?? "",
    input.prompt,
    input.lyrics ?? "",
    input.instrumental ?? null,
    input.durationSeconds ?? null,
    input.format ?? "",
  ]);
}

interface CreateRuntimeMusicContextOptions {
  readonly sessionId: string;
  readonly pluginId: string;
}

export function createRuntimeMusicContext(
  gateway: Required<Pick<PluginRuntimeGateway, "composeMusic">> &
    Pick<PluginRuntimeGateway, "resolveSlot">,
  mediaStore: Pick<MediaStore, "listByMetadata">,
  media: Pick<MediaContext, "put">,
  options: CreateRuntimeMusicContextOptions,
): MusicContext {
  const { sessionId, pluginId } = options;
  return {
    isAvailable(presetId = "music"): boolean {
      return isSlotAvailable(gateway, presetId, "music");
    },

    async generate(input: MusicGenerateInput): Promise<MusicGenerateOutput> {
      input.signal?.throwIfAborted();
      const promptHash = promptHashOf(
        input,
        resolveTargetIdentity(gateway, input.presetId ?? "music", "music"),
      );

      // Framework-injected keys are spread last so plugin-supplied
      // `metadata` can never override them. Same write/read contract as
      // ctx.speech: cache hits stamp THIS call's metadata onto the refs.
      const meta = { ...input.metadata, pluginId, promptHash };

      const cached = await cachedSingleRef(mediaStore, sessionId, meta);
      if (cached) return { refs: [cached], warnings: [], cached: true };

      const result = await gateway.composeMusic({
        presetId: input.presetId,
        prompt: input.prompt,
        lyrics: input.lyrics,
        instrumental: input.instrumental,
        durationSeconds: input.durationSeconds,
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
  };
}
