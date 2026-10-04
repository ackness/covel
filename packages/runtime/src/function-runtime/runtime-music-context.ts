/**
 * ctx.music pipeline — music generation for function runtimes.
 *
 * Mirrors runtime-speech-context.ts: wraps the low-level
 * `PluginRuntimeGateway.composeMusic()` (raw bytes, no persistence) with
 * promptHash-based dedup plus MediaStore persistence so handlers get
 * `MediaRef`s back. A piece costs far more than a spoken line, so the same
 * request from the same plugin in the same session is never paid for twice.
 */

import { createHash } from "node:crypto";
import { AiProviderError } from "@covel/ai-provider";
import type { MediaStore } from "@covel/store";
import type {
  MediaContext,
  MusicContext,
  MusicGenerateInput,
  MusicGenerateOutput,
  PluginRuntimeGateway,
} from "@covel/shared/plugin-runtime";

/** Deterministic key over generation params — identical calls dedupe. */
function promptHashOf(input: MusicGenerateInput): string {
  const canonical = JSON.stringify([
    input.presetId ?? "",
    input.prompt,
    input.lyrics ?? "",
    input.instrumental ?? null,
    input.durationSeconds ?? null,
    input.format ?? "",
  ]);
  return createHash("sha256").update(canonical).digest("hex");
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
      try {
        return gateway.resolveSlot({ presetId, fallbackTag: "music" }) !== null;
      } catch (error) {
        if (error instanceof AiProviderError && error.code === "CONFIG_ERROR")
          return false;
        throw error;
      }
    },

    async generate(input: MusicGenerateInput): Promise<MusicGenerateOutput> {
      input.signal?.throwIfAborted();
      const promptHash = promptHashOf(input);

      // Framework-injected keys are spread last so plugin-supplied
      // `metadata` can never override them. Same write/read contract as
      // ctx.speech: cache hits stamp THIS call's metadata onto the refs.
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
