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
