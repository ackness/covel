/**
 * Shared adapter helpers.
 *
 * Extracted from `openai-chat`, `openai-responses`, and `anthropic-messages`
 * which each carried byte-identical metadata sanitisers, structurally-identical
 * parameter-override extractors, and an identical media-ref fallback serializer.
 *
 * Behaviour is preserved exactly — each adapter keeps its own protected-key set
 * and its own field map; only the mechanics are unified here.
 */

import type { ImagePart } from "../types.js";

/**
 * Maps a camelCase `parameterOverrides` source key to the provider's wire-format
 * field name. Only `number`-typed source values are copied, mirroring the
 * original per-adapter extractors.
 */
export type ParameterFieldMap = Readonly<Record<string, string>>;

/**
 * Build a wire-format parameter object from the slot-level `parameterOverrides`
 * carried on `providerRequestMetadata`.
 *
 * Returns `{}` when the overrides are absent or not a plain object — identical
 * to the pre-refactor guard in each adapter.
 */
export function extractParameterOverrides(
  meta: Record<string, unknown> | undefined,
  fieldMap: ParameterFieldMap,
): Record<string, unknown> {
  const overrides = meta?.parameterOverrides;
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    return {};
  }
  const source = overrides as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [sourceKey, wireKey] of Object.entries(fieldMap)) {
    const value = source[sourceKey];
    if (typeof value === "number") result[wireKey] = value;
  }
  return result;
}

/**
 * Create a metadata sanitiser that drops the adapter's protected keys from
 * `providerRequestMetadata` before it is spread onto the request body.
 *
 * Returns `{}` when `meta` is undefined — identical to the original helpers.
 */
export function createMetadataSanitizer(
  protectedKeys: ReadonlySet<string>,
): (meta: Record<string, unknown> | undefined) => Record<string, unknown> {
  return (meta) => {
    if (!meta) return {};
    const sanitized: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(meta)) {
      if (!protectedKeys.has(k)) sanitized[k] = v;
    }
    return sanitized;
  };
}

/**
 * Serialize a vision `ImagePart` that has no resolved URL into a text
 * placeholder. Shared verbatim by the two OpenAI adapters.
 */
export function mediaRefFallbackText(part: ImagePart): string {
  return JSON.stringify({
    type: "image_ref",
    ref: part.image,
    note: "MediaRef has no resolved URL; provider vision input requires a retrievable image URL.",
  });
}
