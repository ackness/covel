import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { stripPromptCacheMarkers } from "@covel/shared";
import type {
  ProviderConfig,
  TextMessage,
  TextMessageContent,
} from "../types.js";
import { imagePartSource } from "./common.js";
import {
  GOOGLE_PROTOCOL,
  googleError,
  googlePartSchema,
  type GooglePart,
} from "./google-response.js";

type Content = { role: "user" | "model"; parts: Record<string, unknown>[] };
type Call = { name: string; id?: string; order: number };

function serializeContent(
  content: TextMessageContent,
): Record<string, unknown>[] {
  if (typeof content === "string")
    return content ? [{ text: stripPromptCacheMarkers(content) }] : [];
  return (content ?? []).map((part) => {
    if (part.type === "text")
      return { text: stripPromptCacheMarkers(part.text) };
    const source = imagePartSource(part);
    if (source.kind === "data") {
      return {
        inlineData: { mimeType: source.mediaType, data: source.data },
      };
    }
    const mime = part.mediaType;
    if (mime?.startsWith("image/")) {
      let parsed: URL | undefined;
      try {
        parsed = new URL(source.url);
      } catch {
        /* Report the supported forms below. */
      }
      if (
        parsed &&
        parsed.protocol === "https:" &&
        parsed.hostname === "generativelanguage.googleapis.com" &&
        /^\/v1(?:beta)?\/files\/[a-zA-Z0-9_-]+$/.test(parsed.pathname) &&
        !parsed.search &&
        !parsed.hash &&
        !parsed.username &&
        !parsed.password
      ) {
        return { fileData: { mimeType: mime, fileUri: source.url } };
      }
    }
    throw googleError(
      "Gemini images require image data or a Google Files URI with its mediaType; arbitrary image URLs must be resolved before generation",
      true,
    );
  });
}

function nativeParts(
  message: TextMessage,
  config: ProviderConfig,
  model: string,
): GooglePart[] | undefined {
  const continuation = message.providerContinuation;
  if (!continuation || continuation.protocol !== GOOGLE_PROTOCOL)
    return undefined;
  const parsed = z.array(googlePartSchema).safeParse(continuation.items);
  if (!parsed.success)
    throw googleError("Invalid Gemini provider continuation", true);
  if (
    continuation.model !== model ||
    continuation.baseUrl !== (config.baseUrl ?? "")
  ) {
    if (parsed.data.some((part) => part.thoughtSignature !== undefined)) {
      throw googleError(
        "Gemini signed continuation requires the original protocol, model and base URL",
        true,
      );
    }
    return undefined;
  }
  const nativeCalls = parsed.data
    .filter((part) => part.functionCall)
    .map((part) => part.functionCall!);
  if (
    nativeCalls.length !== (message.toolCalls?.length ?? 0) ||
    nativeCalls.some((call, index) => {
      const generic = message.toolCalls?.[index];
      if (
        !generic ||
        call.name !== generic.name ||
        (call.id !== undefined && call.id !== generic.id)
      )
        return true;
      try {
        // Property order is immaterial, but array order and argument values
        // must match before reusing the provider's ordered, opaque parts.
        return !isDeepStrictEqual(
          call.args ?? {},
          JSON.parse(generic.arguments),
        );
      } catch {
        return true;
      }
    })
  ) {
    throw googleError(
      "Gemini continuation does not match the assistant tool calls",
      true,
    );
  }
  return parsed.data;
}

function toolResponse(content: TextMessageContent): Record<string, unknown> {
  const parts = serializeContent(content);
  if (parts.some((part) => typeof part.text !== "string")) {
    throw googleError(
      "Gemini function results currently require text or JSON content",
      true,
    );
  }
  const text = parts.map((part) => part.text).join("\n");
  let value: unknown = text;
  try {
    value = JSON.parse(text);
  } catch {
    /* A plain text tool result is valid. */
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { result: value };
}

const hasFunctionCall = (content: Content | undefined): boolean =>
  content?.role === "model" &&
  content.parts.some((part) => part.functionCall !== undefined);

const hasFunctionResponse = (content: Content): boolean =>
  content.parts.some((part) => part.functionResponse !== undefined);

/**
 * Appends a turn, merging it into the previous one when the role repeats and
 * neither holds a function part. A model turn that calls functions stays
 * whole, so the function responses still follow it directly, and the content
 * with the function responses holds nothing else: text that follows them is
 * the next `user` content. That is the shape this adapter always sent for a
 * tool result followed by a user message, and the one the AI SDK's Google
 * provider sends; a `functionResponse` next to instruction text in one
 * content has not been checked against Google's endpoint.
 */
function pushContent(
  contents: Content[],
  content: Content,
  merge = true,
): void {
  if (!content.parts.length) return;
  const last = contents.at(-1);
  if (
    merge &&
    last &&
    last.role === content.role &&
    !hasFunctionCall(last) &&
    !hasFunctionResponse(last)
  ) {
    last.parts.push(...content.parts);
    return;
  }
  contents.push(content);
}

/**
 * Preserve model part order and associate parallel responses by call ID.
 *
 * Only the system messages ahead of the conversation go to
 * `systemInstruction`, which precedes `contents` on the wire. A later one (the
 * kernel's per-turn context) has no role of its own inside `contents`, so it
 * stays where it is as `user` text in `<system-instruction>` tags: text that
 * changes every turn then leaves the request prefix up to the end of the
 * history unchanged, which is what Gemini's prefix cache matches on.
 *
 * `lateSystemInPlace: false` (the slot's `lateSystemAsUser = false`) sends the
 * earlier shape instead, for an endpoint that refuses this one: every system
 * message in `systemInstruction`, and one content per message.
 */
export function googleMessages(
  messages: TextMessage[],
  config: ProviderConfig,
  model: string,
  lateSystemInPlace = true,
): Record<string, unknown> {
  const contents: Content[] = [];
  const systemParts: Record<string, unknown>[] = [];
  const calls = new Map<string, Call>();
  // Instructions that arrived between a function call and its responses; they
  // go out as the `user` content after the responses, which must follow the
  // call directly.
  let afterResponses: Record<string, unknown>[] = [];
  let leading = true;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role === "system" || message.role === "developer") {
      const parts = serializeContent(message.content);
      if (parts.some((part) => typeof part.text !== "string"))
        throw googleError("Gemini system instructions require text", true);
      if (leading) {
        systemParts.push(...parts);
        continue;
      }
      const text = parts.map((part) => part.text).join("\n");
      if (!text) continue;
      const instruction = {
        text: `<system-instruction>\n${text}\n</system-instruction>`,
      };
      if (hasFunctionCall(contents.at(-1))) afterResponses.push(instruction);
      else pushContent(contents, { role: "user", parts: [instruction] });
      continue;
    }
    leading = !lateSystemInPlace;
    if (message.role === "tool") {
      const responses: { call: Call; part: Record<string, unknown> }[] = [];
      const seen = new Set<string>();
      while (index < messages.length && messages[index]!.role === "tool") {
        const result = messages[index]!;
        const call = result.toolCallId
          ? calls.get(result.toolCallId)
          : undefined;
        if (!call || !result.toolCallId || seen.has(result.toolCallId))
          throw googleError(
            "Gemini tool result requires a unique preceding tool call ID",
            true,
          );
        seen.add(result.toolCallId);
        responses.push({
          call,
          part: {
            functionResponse: {
              name: call.name,
              ...(call.id ? { id: call.id } : {}),
              response: toolResponse(result.content),
            },
          },
        });
        index++;
      }
      index--;
      responses.sort((left, right) => left.call.order - right.call.order);
      contents.push({
        role: "user",
        parts: responses.map((response) => response.part),
      });
      pushContent(contents, { role: "user", parts: afterResponses });
      afterResponses = [];
      continue;
    }
    if (message.role !== "assistant" && message.role !== "user")
      throw googleError(
        `Unsupported Gemini message role: ${message.role}`,
        true,
      );
    let parts: Record<string, unknown>[];
    if (message.role === "assistant") {
      const native = nativeParts(message, config, model);
      const nativeCalls = native
        ?.filter((part) => part.functionCall)
        .map((part) => part.functionCall!);
      const generic = (message.toolCalls ?? []).map((call, order) => {
        let args: unknown;
        try {
          args = JSON.parse(call.arguments);
        } catch {
          throw googleError(
            "Gemini tool arguments must be valid JSON objects",
            true,
          );
        }
        const parsed = z.record(z.string(), z.json()).safeParse(args);
        if (!parsed.success)
          throw googleError(
            "Gemini tool arguments must be valid JSON objects",
            true,
          );
        const nativeId = nativeCalls?.[order]?.id;
        calls.set(call.id, {
          name: call.name,
          ...(nativeId ? { id: nativeId } : {}),
          order,
        });
        return { functionCall: { name: call.name, args: parsed.data } };
      });
      parts = native ?? [...serializeContent(message.content), ...generic];
    } else {
      parts = serializeContent(message.content);
    }
    pushContent(
      contents,
      { role: message.role === "assistant" ? "model" : "user", parts },
      lateSystemInPlace,
    );
  }
  pushContent(contents, { role: "user", parts: afterResponses });
  return {
    contents,
    ...(systemParts.length
      ? { systemInstruction: { parts: systemParts } }
      : {}),
  };
}
