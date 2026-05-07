/**
 * Shared LLM message content-part types.
 *
 * `LLMMessage.content` is allowed to be either a plain string (text-only,
 * the historical default) or an ordered array of content parts when a
 * message carries multimodal data such as a generated image.
 *
 * This type intentionally lives in `@covel/shared` so it is reachable from
 * both `@covel/context` (which assembles the LLM history) and
 * `@covel/ai-provider` (which serialises the wire payload). Each layer
 * keeps its own structural alias on top — `@covel/ai-provider` already
 * exposes `TextMessageContentPart` and `@covel/context` re-exports
 * `ContentPart` from here — but the field shapes match so values can pass
 * through without conversion.
 *
 * Image parts carry a {@link MediaRef} (not a bare URL) so adapters retain
 * the original asset id, mime, and size for fallback rendering when a
 * provider rejects vision content or a URL has not yet been resolved.
 */

import type { MediaRef } from "./media.js";

/** A plain text segment. */
export interface TextContentPart {
  readonly type: "text";
  readonly text: string;
}

/**
 * An image segment, carrying the originating {@link MediaRef}. Provider
 * adapters should prefer `image.url` when present and fall back to a
 * structured text descriptor otherwise — see the `mediaRefFallbackText`
 * helpers in `@covel/ai-provider`.
 */
export interface ImageContentPart {
  readonly type: "image";
  readonly image: MediaRef;
}

/** Discriminated union of every supported content-part variant. */
export type ContentPart = TextContentPart | ImageContentPart;
