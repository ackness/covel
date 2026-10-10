/**
 * Model-capability fallback for multimodal message content.
 *
 * A request may carry image parts. When the model that actually takes the
 * call (the slot's target, or a fallback the gateway moved to) is known not
 * to accept image input, the image parts are removed so the request still
 * reaches the provider in a shape it understands. Whoever built the request
 * put the same information in text: the kernel's history holds a note for
 * every picture.
 *
 * When `context` is missing or `capability.input` is undefined, the messages
 * are returned untouched (no information to act on).
 *
 * This wrapper is the only place that needs to know about model capability;
 * per-protocol serializers stay focused on wire format.
 */

import type {
  ModelRequestContext,
  TextMessage,
  TextMessageContent,
} from "../types.js";
import { IMAGE_PLACEHOLDER_TEXT } from "./common.js";

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
  return withoutImageParts(messages);
}

/**
 * The messages with their image parts removed; the same array when there
 * are none. A message of images only becomes the text `[image]`.
 */
export function withoutImageParts<M extends TextMessage>(
  messages: readonly M[],
): M[] {
  let mutated = false;
  const next = messages.map((msg) => {
    const downgraded = downgradeContent(msg.content);
    if (downgraded === msg.content) return msg;
    mutated = true;
    return { ...msg, content: downgraded };
  });
  return mutated ? next : (messages as M[]);
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
  const text = content.filter((part) => part.type === "text");
  if (text.length === content.length) return content;
  // A message of images only keeps its place in the conversation.
  return text.length > 0
    ? text
    : [{ type: "text" as const, text: IMAGE_PLACEHOLDER_TEXT }];
}
