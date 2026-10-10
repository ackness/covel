/**
 * Pictures of the session that a story model is shown as images.
 *
 * The context builder puts the newest pictures of the history in one message
 * of text and `media` parts (a `MediaRef` each, no bytes). Right before a
 * model call the loop either replaces every `media` part with the image
 * itself, read from the MediaStore, or removes the message: a model that is
 * not known to accept image input gets the notes in the history and nothing
 * else. The bytes exist only in the request that is sent; the transcript, a
 * suspended continuation and the hooks keep the reference.
 */

import type { LLMContentPart, LLMImagePart, MediaRef } from "@covel/shared";
import type { LLMMessage } from "../llm/llm-adapter.js";
import type { MediaStoreLike } from "../function-runtime/runtime-media-context.js";

/**
 * Pictures a story request carries. An image costs roughly 800 to 1,600
 * input tokens and its base64 body up to a few megabytes on every call of
 * the turn, outside the cached history; two keep the scene the player is
 * looking at and the one before it for about 3,000 tokens.
 */
export const MAX_PICTURE_ATTACHMENTS = 2;

/**
 * Largest picture sent, in bytes. Base64 adds a third, so this is 5 MB on
 * the wire: the smallest per-image limit among the supported providers.
 */
export const MAX_PICTURE_BYTES = 3_750_000;

/** Formats every image-input protocol the adapters speak accepts. */
const PICTURE_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

function hasMediaPart(message: LLMMessage): boolean {
  // A replayed tool-call message can hold `null` content.
  return (
    Array.isArray(message.content) &&
    message.content.some((part) => part.type === "media")
  );
}

/** Whether any message still refers to a stored picture. */
export function hasPictureAttachments(
  messages: readonly LLMMessage[],
): boolean {
  return messages.some(hasMediaPart);
}

/** The request without its picture messages, for a model that reads no image. */
export function withoutPictureAttachments(
  messages: readonly LLMMessage[],
): LLMMessage[] {
  return messages.filter((message) => !hasMediaPart(message));
}

export interface PictureLoader {
  /** The picture as an image part, or `null` when it cannot be sent. */
  load(ref: MediaRef): Promise<LLMImagePart | null>;
}

/**
 * Reads pictures for one session. A picture is sent only when the session
 * owns or references it (the check `/api/media/:id` makes), its format is one
 * every provider reads, and it is within {@link MAX_PICTURE_BYTES}. Results
 * are kept for the loop: every call of a turn sends the same pictures.
 */
export function createPictureLoader(
  mediaStore: MediaStoreLike | undefined,
  sessionId: string,
): PictureLoader {
  const loaded = new Map<string, Promise<LLMImagePart | null>>();
  const read = async (ref: MediaRef): Promise<LLMImagePart | null> => {
    if (!mediaStore) return null;
    try {
      const asset = await mediaStore.lookup(ref.id);
      if (!asset || asset.size > MAX_PICTURE_BYTES) return null;
      const mediaType = asset.mime.split(";")[0]!.trim().toLowerCase();
      if (!PICTURE_MEDIA_TYPES.has(mediaType)) return null;
      if (!(await mediaStore.isReferencedBy(ref.id, sessionId))) return null;
      const stored = await mediaStore.get({ ...ref, mime: asset.mime });
      const bytes =
        stored instanceof Uint8Array
          ? stored
          : new Uint8Array(await stored.arrayBuffer());
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_PICTURE_BYTES)
        return null;
      return {
        type: "image",
        image: Buffer.from(bytes).toString("base64"),
        mediaType,
      };
    } catch (error) {
      // A picture that cannot be read is left out; the note in the history
      // still tells the model about it.
      console.warn(
        `[picture-attachments] picture not sent for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  };
  return {
    load(ref) {
      let pending = loaded.get(ref.id);
      if (!pending) {
        pending = read(ref);
        loaded.set(ref.id, pending);
      }
      return pending;
    },
  };
}

/**
 * Replace every `media` part with its image. A picture that cannot be sent
 * goes together with the line of text in front of it, and a message left
 * with no image is removed.
 */
export async function inlinePictureAttachments(
  messages: readonly LLMMessage[],
  loader: PictureLoader,
): Promise<LLMMessage[]> {
  const out: LLMMessage[] = [];
  for (const message of messages) {
    if (!hasMediaPart(message) || typeof message.content === "string") {
      out.push(message);
      continue;
    }
    const parts: LLMContentPart[] = [];
    let images = 0;
    for (const part of message.content) {
      if (part.type !== "media") {
        parts.push(part);
        continue;
      }
      const image = await loader.load(part.ref);
      if (image) {
        parts.push(image);
        images++;
      } else if (parts.at(-1)?.type === "text" && parts.length > 1) {
        parts.pop();
      }
    }
    if (images > 0) out.push({ ...message, content: parts });
  }
  return out;
}
