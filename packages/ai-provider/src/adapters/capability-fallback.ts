/**
 * Model-capability fallback for multimodal message content.
 *
 * Context-builder hands every adapter a `TextMessageContent` that may be a
 * `string` or a `readonly TextMessageContentPart[]` containing image
 * segments (added by the 2026-04-26 multimodal audit fix). When the
 * resolved model does NOT accept image input, those image parts must be
 * collapsed into their text descriptors so the request still reaches the
 * provider in a shape it understands.
 *
 * The fallback is conservative:
 *   - When `context` is missing or `capability.input` is undefined, the
 *     messages are returned untouched (no information to act on).
 *   - When the model is text-only, image parts become a JSON `image_ref`
 *     descriptor — same shape used by the URL-missing fallback in each
 *     wire serializer — so the model still sees the asset id, mime, and
 *     size for downstream reasoning.
 *
 * This wrapper is the only place that needs to know about model
 * capability; per-protocol serializers stay focused on wire format.
 */

import type { ModelRequestContext, TextMessage, TextMessageContent } from "../types.js";

/**
 * Return a message list safe to send to the resolved model. When the
 * model accepts image input (or capability information is absent), the
 * input array is returned by reference for zero allocation.
 */
export function applyCapabilityFallback(
  messages: TextMessage[],
  context: ModelRequestContext | undefined,
): TextMessage[] {
  if (!shouldDowngrade(context)) return messages;
  let mutated = false;
  const next = messages.map((msg) => {
    const downgraded = downgradeContent(msg.content);
    if (downgraded === msg.content) return msg;
    mutated = true;
    return { ...msg, content: downgraded };
  });
  return mutated ? next : messages;
}

function shouldDowngrade(context: ModelRequestContext | undefined): boolean {
  const capability = context?.preset?.capability;
  if (!capability) return false;
  // `input` is optional — treat undefined as "we don't know, leave it alone".
  if (!capability.input) return false;
  return !capability.input.includes("image");
}

function downgradeContent(content: TextMessageContent): TextMessageContent {
  if (!Array.isArray(content)) return content;
  let mutated = false;
  const next = content.map((part) => {
    if (part.type === "text") return part;
    mutated = true;
    return {
      type: "text" as const,
      text: JSON.stringify({
        type: "image_ref",
        ref: part.image,
        note: "Model does not accept image input; image part was downgraded to a text descriptor.",
      }),
    };
  });
  return mutated ? next : content;
}
