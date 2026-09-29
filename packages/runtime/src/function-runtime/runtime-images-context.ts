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
import { AiProviderError } from "@covel/ai-provider";
import type { MediaRef } from "@covel/shared";
import type { MediaStore } from "@covel/store";
import type {
  MediaContext,
  ImageGenerateInput,
  ImageGenerateOutput,
  ImagesContext,
  PluginRuntimeGateway,
  ImageGenerationTarget,
} from "@covel/shared/plugin-runtime";

const INGEST_ALLOWED_MIMES = ["image/png", "image/jpeg", "image/webp"];

/** Deterministic key over generation params — identical calls dedupe. */
function promptHashOf(
  input: ImageGenerateInput,
  target: ImageGenerationTarget,
): string {
  const canonical = JSON.stringify([
    // Model bindings can change while the role name and prompt stay the same.
    // Credentials are deliberately excluded from both the key and media metadata.
    target.provider,
    target.model,
    target.protocol,
    target.baseUrl ?? "",
    canonicalMetadata(target.metadata),
    input.prompt,
    input.negativePrompt ?? "",
    input.size ?? "",
    input.quality ?? "",
    input.n ?? 1,
    input.background ?? "",
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

function canonicalMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalMetadata);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonicalMetadata(item)]),
    );
  return value;
}

interface CreateRuntimeImagesContextOptions {
  readonly sessionId: string;
  readonly pluginId: string;
}

export function createRuntimeImagesContext(
  gateway: Required<
    Pick<PluginRuntimeGateway, "generateImage" | "resolveSlot">
  >,
  mediaStore: Pick<MediaStore, "listByMetadata">,
  media: Pick<MediaContext, "put" | "ingestUrl">,
  options: CreateRuntimeImagesContextOptions,
): ImagesContext {
  const { sessionId, pluginId } = options;
  return {
    isAvailable(presetId = "image"): boolean {
      try {
        return gateway.resolveSlot({ presetId, fallbackTag: "image" }) !== null;
      } catch (error) {
        if (error instanceof AiProviderError && error.code === "CONFIG_ERROR")
          return false;
        throw error;
      }
    },
    async generate(input: ImageGenerateInput): Promise<ImageGenerateOutput> {
      input.signal?.throwIfAborted();
      const presetId = input.presetId ?? "image";
      const target = gateway.resolveSlot({ presetId, fallbackTag: "image" });
      if (!target)
        throw new AiProviderError({
          code: "CONFIG_ERROR",
          provider: "unconfigured",
          retriable: false,
          message: `Image model role "${presetId}" is not configured. Configure an image model for this role in model settings or llm.toml.`,
        });
      const promptHash = promptHashOf(input, target);

      // Framework-injected keys are spread last so plugin-supplied
      // `metadata` can never override them. Computed up front so a cache
      // hit stamps THIS call's metadata onto the returned refs — the stored
      // record keeps the first call's meta (write/read stay consistent), but
      // consumers indexing off the returned refs see their own values, not
      // a stale sceneId/variant from whoever generated the prompt first.
      const meta = { ...input.metadata, pluginId, promptHash };

      const wantedCount = input.n ?? 1;
      const existing = await mediaStore.listByMetadata(sessionId, {
        promptHash,
        pluginId,
      });
      input.signal?.throwIfAborted();
      // A partial hit (e.g. one of two images failed to persist on a prior
      // call) must NOT be served as cached — it would silently hand back
      // fewer images than requested and never retry the missing ones.
      if (existing.length >= wantedCount) {
        return {
          refs: existing.slice(0, wantedCount).map((asset): MediaRef => ({
            id: asset.id,
            mime: asset.mime,
            size: asset.size,
            meta,
          })),
          warnings: [],
          cached: true,
        };
      }

      const result = await gateway.generateImage({
        presetId,
        prompt: input.prompt,
        negativePrompt: input.negativePrompt,
        size: input.size,
        quality: input.quality,
        n: input.n,
        background: input.background,
        signal: input.signal,
      });

      // A TOML reload can change a role while the cache lookup awaits storage.
      // Persist under the dispatched target, including A -> B -> A changes.
      const generatedMeta = {
        ...meta,
        promptHash: promptHashOf(input, result.target),
      };

      const refs: MediaRef[] = [];
      for (const image of result.images) {
        refs.push(
          image.kind === "url"
            ? await media.ingestUrl(image.url, {
                allowedMimes: INGEST_ALLOWED_MIMES,
                meta: generatedMeta,
              })
            : await media.put(image.bytes, image.mime, generatedMeta),
        );
      }
      return { refs, warnings: result.warnings, cached: false };
    },
  };
}
