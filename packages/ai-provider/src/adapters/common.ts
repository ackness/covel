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

import { createHash } from "node:crypto";
import type { ImagePart, TextMessage } from "../types.js";
import { readReasoningEffort } from "../reasoning-effort.js";

/**
 * IDs for the tool calls of a response that came without them. The AI SDK
 * makes up a random ID here; this one is a digest of the request body and the
 * call's position instead, so it is as unique (each step of a tool loop sends
 * a different body, and so does each runtime) and a recorded session still
 * repeats byte for byte. The form is the one OpenAI uses, which every wire
 * accepts when the ID is sent back.
 */
export function fallbackToolCallIds(
  requestBody: Record<string, unknown>,
): (index: number) => string {
  let request: string | undefined;
  return (index) => {
    request ??= JSON.stringify(requestBody);
    const digest = createHash("sha256")
      .update(request)
      .update(`\n${index}`)
      .digest("hex");
    return `call_${digest.slice(0, 24)}`;
  };
}

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

/**
 * Re-labels every system message that follows the first conversation message
 * as a `user` message in a `<system-instruction>` envelope. Leading system
 * messages stay as they are.
 *
 * The kernel puts the per-turn context (data blocks, rules for this turn) in a
 * system message after the committed history, so that the history stays a
 * stable prefix. A server that reads the request in order keeps that prefix.
 * A relay that moves every system message to the front, or converts the
 * request to a protocol with one system slot, puts the changing text ahead of
 * the history, and everything after it misses the cache. A user message keeps
 * its place on every route. The Anthropic adapter does the same.
 */
export function lateSystemMessagesAsUser(
  messages: readonly TextMessage[],
): TextMessage[] {
  const isInstruction = (m: TextMessage) =>
    m.role === "system" || m.role === "developer";
  const first = messages.findIndex((m) => !isInstruction(m));
  if (first < 0) return [...messages];
  return messages.map((message, index) => {
    if (index < first || !isInstruction(message)) return message;
    const open = "<system-instruction>\n";
    const close = "\n</system-instruction>";
    const content = message.content;
    return {
      ...message,
      role: "user",
      content:
        typeof content === "string" || content === null
          ? `${open}${content ?? ""}${close}`
          : [
              { type: "text", text: open },
              ...content,
              { type: "text", text: close },
            ],
    };
  });
}

/**
 * Applies `lateSystemMessagesAsUser` when the slot's `lateSystemAsUser`
 * provider option is on (metadata key `lateSystemAsUser`, default off).
 */
export function lateSystemOption(
  messages: TextMessage[],
  metadata: Record<string, unknown> | undefined,
): TextMessage[] {
  return metadata?.lateSystemAsUser === true
    ? lateSystemMessagesAsUser(messages)
    : messages;
}
