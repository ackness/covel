import { stripPromptCacheMarkers } from "@covel/shared";
import type { TextGenerationParams } from "../types.js";
import type { ModelProviderAdapter } from "../adapters/adapter.js";
import {
  objectResponseFormat,
  withResponseFormatInstruction,
} from "../adapters/structured-output.js";
import {
  createStructuredOutputError,
  createUnsupportedModeError,
} from "../adapters/http.js";
import {
  getWire,
  listWires,
  registerWire,
  type WireOwner,
} from "../wire-lifecycle.js";
import type { TextWire } from "./types.js";

/** With `owner`, the wire serves only sessions in which that plugin is active. */
export function registerTextWire(
  wire: TextWire,
  owner?: WireOwner,
): () => void {
  return registerWire("text", wire, owner);
}
export function getTextWire(id: string): TextWire | null {
  return getWire("text", id);
}
export function listTextWires(): TextWire[] {
  return listWires("text");
}

/** Internal cache sentinels never cross the plugin wire boundary. */
function cleanMessages<T extends TextGenerationParams>(params: T): T {
  return {
    ...params,
    messages: params.messages.map((message) => ({
      ...message,
      content:
        typeof message.content === "string"
          ? stripPromptCacheMarkers(message.content)
          : (message.content?.map((part) =>
              part.type === "text"
                ? { ...part, text: stripPromptCacheMarkers(part.text) }
                : part,
            ) ?? null),
    })),
  };
}

/** The adapter a slot on this wire resolves to. */
export function textWireAdapter(wire: TextWire): ModelProviderAdapter {
  return {
    generateText: (config, params, context) =>
      wire.generateText(config, cleanMessages(params), context),
    streamText: (config, params, context) =>
      wire.streamText(config, cleanMessages(params), context),
    async generateObject(config, params, context) {
      params = cleanMessages(params);
      if (wire.generateObject)
        return wire.generateObject(config, params, context);
      const { schema, ...text } = params;
      const responseFormat = objectResponseFormat(schema, wire.id);
      const result = await wire.generateText(
        config,
        {
          ...text,
          messages: withResponseFormatInstruction(
            text.messages,
            responseFormat,
            text.instructionLocale,
          ),
          responseFormat,
        },
        context,
      );
      let raw: unknown;
      try {
        raw = JSON.parse(result.text);
      } catch {
        throw createStructuredOutputError(wire.id, result.usage);
      }
      const validation = schema.safeParse(raw);
      if (!validation.success)
        throw createStructuredOutputError(wire.id, result.usage);
      return {
        ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
        object: validation.data,
        ...(result.reasoningContent
          ? { reasoningContent: result.reasoningContent }
          : {}),
        finishReason: result.finishReason,
        usage: result.usage,
      };
    },
    async embed() {
      throw createUnsupportedModeError(wire.id, "embed");
    },
  };
}
