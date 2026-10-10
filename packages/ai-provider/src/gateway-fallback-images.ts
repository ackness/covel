/**
 * Image parts across a text fallback chain.
 *
 * A caller decides whether to send images from what the first model of the
 * chain accepts (`resolveSlot(...).capability.input`). When that model fails
 * and the call moves to the next one, the request is made for the model that
 * is called: no images for one that is not known to read them, and a size
 * check that counts an image as an image.
 */

import { withoutImageParts } from "./adapters/capability-fallback.js";
import type { ResolvedTarget, TextMessage } from "./types.js";

function acceptsImages(target: ResolvedTarget): boolean {
  return target.preset?.capability?.input.includes("image") === true;
}

/**
 * The messages to send to `target`. They are the caller's own for the first
 * target of the chain, and for every target while the first is not known to
 * accept images: then the caller sent them on its own judgement. Otherwise a
 * later target gets them only when it is known to accept images too. The
 * built-in adapters already drop images for a model declared text-only;
 * this also covers a later model of unknown capability, which the caller
 * never checked.
 */
export function messagesForTarget<M extends TextMessage>(
  messages: readonly M[],
  target: ResolvedTarget,
  primary: ResolvedTarget,
): M[] {
  if (target === primary || !acceptsImages(primary) || acceptsImages(target))
    return messages as M[];
  return withoutImageParts(messages);
}

/**
 * What one image is counted as when a request is sized for a fallback
 * model. Providers charge roughly 800 to 1,600 tokens for a picture.
 */
export const IMAGE_TOKEN_ESTIMATE = 1_600;

/** The messages with every image body emptied, and the number of images. */
export function withoutImageBodies(messages: readonly TextMessage[]): {
  messages: TextMessage[];
  count: number;
} {
  let count = 0;
  const emptied = messages.map((message) => {
    const { content } = message;
    if (typeof content === "string" || !content) return message;
    return {
      ...message,
      content: content.map((part) => {
        if (part.type !== "image") return part;
        count += 1;
        return { ...part, image: "" };
      }),
    };
  });
  return { messages: emptied, count };
}
