import { createHash } from "node:crypto";
import { AiProviderError } from "@covel/ai-provider";
import type { MediaRef } from "@covel/shared";
import type { MediaStore } from "@covel/store";
import type {
  ImageGenerationTarget,
  PluginRuntimeGateway,
} from "@covel/shared/plugin-runtime";

/**
 * The part of a media cache key that names the model. A role can be bound to
 * another model while its name and the request stay the same, and the stored
 * result of the old model must not answer for the new one. Credentials are
 * left out of the key and of the media metadata.
 */
export function targetIdentity(target: ImageGenerationTarget): unknown[] {
  return [
    target.provider,
    target.model,
    target.protocol,
    target.baseUrl ?? "",
    canonicalMetadata(target.metadata),
  ];
}

/**
 * The identity of the model a role resolves to now, or `null` when the role
 * cannot be resolved; the generation call then reports why.
 */
export function resolveTargetIdentity(
  gateway: Pick<PluginRuntimeGateway, "resolveSlot">,
  presetId: string,
  fallbackTag: string,
): unknown[] | null {
  try {
    const target = gateway.resolveSlot({ presetId, fallbackTag });
    return target ? targetIdentity(target) : null;
  } catch {
    return null;
  }
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

/** Keep each modality's ordered key parts stable while sharing the hash format. */
export function mediaPromptHash(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function isSlotAvailable(
  gateway: Pick<PluginRuntimeGateway, "resolveSlot">,
  presetId: string,
  fallbackTag: string,
): boolean {
  try {
    return gateway.resolveSlot({ presetId, fallbackTag }) !== null;
  } catch (error) {
    if (error instanceof AiProviderError && error.code === "CONFIG_ERROR")
      return false;
    throw error;
  }
}

/** A single-asset hit uses this call's metadata, not the original call's. */
export async function cachedSingleRef(
  mediaStore: Pick<MediaStore, "listByMetadata">,
  sessionId: string,
  meta: NonNullable<MediaRef["meta"]> & {
    pluginId: string;
    promptHash: string;
  },
): Promise<MediaRef | undefined> {
  const [asset] = await mediaStore.listByMetadata(sessionId, {
    promptHash: meta.promptHash,
    pluginId: meta.pluginId,
  });
  return asset
    ? { id: asset.id, mime: asset.mime, size: asset.size, meta }
    : undefined;
}
