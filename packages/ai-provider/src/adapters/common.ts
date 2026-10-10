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
import { readReasoningEffort } from "../reasoning-effort.js";

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
    const selection = readReasoningEffort(meta);
    // Explicit UI selections own the budget too; Qwen rejects budget + effort.
    if (selection) delete sanitized.thinking_budget;
    if (selection === "provider-default") {
      // This is an explicit opt-out, not inheritance from a lower layer.
      delete sanitized.enable_thinking;
      delete sanitized.thinking;
      delete sanitized.reasoning_effort;
      for (const key of ["reasoning", "output_config"]) {
        const value = sanitized[key];
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const rest = { ...value } as Record<string, unknown>;
          delete rest.effort;
          if (Object.keys(rest).length) sanitized[key] = rest;
          else delete sanitized[key];
        }
      }
    }
    return sanitized;
  };
}

/** Where the bytes of an image part are: inline, or at a URL the provider reads. */
export type ImageSource =
  | { readonly kind: "data"; readonly mediaType: string; readonly data: string }
  | { readonly kind: "url"; readonly url: string };

/** Base64 openings of the formats the image-input protocols accept. */
const BASE64_SIGNATURES: readonly (readonly [string, string])[] = [
  ["iVBORw0KGgo", "image/png"],
  ["/9j/", "image/jpeg"],
  ["R0lGOD", "image/gif"],
  ["UklGR", "image/webp"],
];

/**
 * Read an image part. A `data:` URL names its own format; bare base64 takes
 * `mediaType`, else the format its first bytes show.
 */
export function imagePartSource(part: ImagePart): ImageSource {
  const { image } = part;
  if (/^https?:\/\//i.test(image)) return { kind: "url", url: image };
  const dataUrl = /^data:([a-z0-9.+/-]+);base64,/i.exec(image);
  if (dataUrl) {
    return {
      kind: "data",
      mediaType: dataUrl[1]!.toLowerCase(),
      data: image.slice(dataUrl[0].length),
    };
  }
  return {
    kind: "data",
    mediaType:
      part.mediaType ??
      BASE64_SIGNATURES.find(([prefix]) => image.startsWith(prefix))?.[1] ??
      "image/png",
    data: image,
  };
}

/** The `data:` or `http(s)` URL of an image part, for the wires that take one. */
export function imagePartUrl(part: ImagePart): string {
  const source = imagePartSource(part);
  return source.kind === "url"
    ? source.url
    : `data:${source.mediaType};base64,${source.data}`;
}

/** Stands for an image where a wire field holds text only. */
export const IMAGE_PLACEHOLDER_TEXT = "[image]";
