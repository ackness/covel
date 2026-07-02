/**
 * ctx.images pipeline — unified image generation for function runtimes.
 *
 * Wraps `PluginRuntimeGateway.generateImage()` (raw bytes/URLs, no
 * persistence) with promptHash-based dedup plus MediaStore persistence, so
 * plugin handlers get `MediaRef`s back instead of hand-rolling their own
 * generate → download → put logic. Ownership recording is delegated to the
 * caller's already-wired `ctx.media` (`put`/`ingestUrl`), so this module
 * only adds dedup + metadata stamping on top.
 */

import { createHash } from "node:crypto";
import type { MediaRef } from "@covel/shared";
import type { MediaStore } from "@covel/store";
import type {
  FunctionHandlerContext,
  ImageGenerateInput,
  ImageGenerateOutput,
  ImagesContext,
  PluginRuntimeGateway,
} from "@covel/plugin-loader";

// `MediaContext` itself isn't re-exported from the plugin-loader barrel
// (same workaround as runtime-media-context.ts) — derive it structurally.
type MediaContext = NonNullable<FunctionHandlerContext["media"]>;

const INGEST_ALLOWED_MIMES = ["image/png", "image/jpeg", "image/webp"];

/** Deterministic key over generation params — identical calls dedupe. */
function promptHashOf(input: ImageGenerateInput): string {
  const canonical = JSON.stringify([
    input.presetId ?? "",
    input.prompt,
    input.negativePrompt ?? "",
    input.size ?? "",
    input.quality ?? "",
    input.n ?? 1,
    input.background ?? "",
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

interface CreateRuntimeImagesContextOptions {
  readonly sessionId: string;
  readonly pluginId: string;
}

export function createRuntimeImagesContext(
  gateway: Required<Pick<PluginRuntimeGateway, "generateImage">>,
  mediaStore: Pick<MediaStore, "listByMetadata">,
  media: Pick<MediaContext, "put" | "ingestUrl">,
  options: CreateRuntimeImagesContextOptions,
): ImagesContext {
  const { sessionId, pluginId } = options;
  return {
    async generate(input: ImageGenerateInput): Promise<ImageGenerateOutput> {
      const promptHash = promptHashOf(input);

      const wantedCount = input.n ?? 1;
      const existing = await mediaStore.listByMetadata(sessionId, {
        promptHash,
        pluginId,
      });
      // A partial hit (e.g. one of two images failed to persist on a prior
      // call) must NOT be served as cached — it would silently hand back
      // fewer images than requested and never retry the missing ones.
      if (existing.length >= wantedCount) {
        return {
          refs: existing.slice(0, wantedCount).map(
            (asset): MediaRef => ({
              id: asset.id,
              mime: asset.mime,
              size: asset.size,
              ...(asset.meta ? { meta: asset.meta } : {}),
            }),
          ),
          warnings: [],
          cached: true,
        };
      }

      const result = await gateway.generateImage({
        presetId: input.presetId,
        prompt: input.prompt,
        negativePrompt: input.negativePrompt,
        size: input.size,
        quality: input.quality,
        n: input.n,
        background: input.background,
        signal: input.signal,
      });

      // Framework-injected keys are spread last so plugin-supplied
      // `metadata` can never override them.
      const meta = { ...input.metadata, pluginId, promptHash };

      const refs: MediaRef[] = [];
      for (const image of result.images) {
        refs.push(
          image.kind === "url"
            ? await media.ingestUrl(image.url, {
                allowedMimes: INGEST_ALLOWED_MIMES,
                meta,
              })
            : await media.put(image.bytes, image.mime, meta),
        );
      }
      return { refs, warnings: result.warnings, cached: false };
    },
  };
}
