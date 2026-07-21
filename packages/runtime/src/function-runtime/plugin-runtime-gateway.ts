/**
 * Bridge adapter: @covel/ai-provider gateway → PluginRuntimeGateway facade.
 *
 * `PluginRuntimeGateway` (defined in @covel/plugin-loader) is the narrow
 * surface exposed to function-runtime handlers via `FunctionHandlerContext
 * .gateway`. This file wraps the full `Gateway` returned by
 * `createGateway()` and adapts its shapes (Zod schemas, `dataBase64` vs
 * `base64`, etc.) into the facade's plain-object form. Kept inside
 * @covel/runtime — the same place `createGatewayAdapter` lives — so
 * callers don't need to import both packages just to wire the executor.
 *
 * The `GatewayImageLike` / `GatewayTextLike` / `GatewayObjectLike`
 * structural types mirror just the fields we need, so @covel/runtime
 * keeps zero static dependency on @covel/ai-provider.
 */

import type {
  PluginRuntimeGateway,
  ResolvedSlotForPlugin,
} from "@covel/plugin-loader";
import type { ZodType } from "zod";
import type {
  GatewayAdapterConfig,
  SlotOverridesInput,
} from "../llm/gateway-llm-adapter.js";

/**
 * Common request-shaping options accepted by the full ai-provider gateway.
 * Mirrors `GatewayOptions` (apiKeys / traceId / signal / slotOverrides) via
 * a structural type so `@covel/runtime` stays decoupled from ai-provider.
 */
interface FullGatewayOptions {
  apiKeys?: Record<string, string>;
  /** Server-env keys — origin-gated by the gateway, unlike apiKeys. */
  envApiKeys?: Record<string, string>;
  traceId?: string;
  signal?: AbortSignal;
  slotOverrides?: SlotOverridesInput;
}

/**
 * Narrow structural projection of the full ai-provider `Gateway` shape —
 * only the three methods we adapt for plugins.
 */
export interface FullGatewayLike {
  generateText(
    input: {
      presetId?: string;
      messages: Array<{ role: string; content: string | null }>;
      providerRequestMetadata?: Record<string, unknown>;
    },
    options?: FullGatewayOptions,
  ): Promise<{
    text: string;
    finishReason: string;
    usage: { inputTokens: number; outputTokens: number };
  }>;

  generateObject<T>(
    input: {
      presetId?: string;
      schema: ZodType<T>;
      messages: Array<{ role: string; content: string | null }>;
      providerRequestMetadata?: Record<string, unknown>;
    },
    options?: FullGatewayOptions,
  ): Promise<{
    object: T;
    finishReason: string;
    usage: { inputTokens: number; outputTokens: number };
  }>;

  resolveSlot(
    presetId: string | undefined,
    options?: FullGatewayOptions & { fallbackTag?: string },
  ): {
    presetId: string;
    provider: string;
    protocol: string;
    baseUrl?: string;
    apiKey?: string;
    headers?: Record<string, string>;
    model: string;
    tag: string;
    metadata: Record<string, unknown>;
  } | null;

  /**
   * Optional — only present on gateways built with image wires registered.
   * Mirrors `PluginRuntimeGateway.generateImage`; the facade below exposes
   * it only when the underlying gateway actually has it wired.
   */
  generateImage?(
    input: {
      presetId?: string;
      prompt: string;
      negativePrompt?: string;
      size?: string;
      quality?: string;
      n?: number;
      background?: "transparent" | "opaque";
    },
    options?: FullGatewayOptions,
  ): Promise<{
    images: ReadonlyArray<
      | { kind: "bytes"; bytes: Uint8Array; mime: string }
      | { kind: "url"; url: string; mime: string }
    >;
    warnings: readonly string[];
  }>;

  /** Optional — mirrors `PluginRuntimeGateway.synthesizeSpeech`. */
  synthesizeSpeech?(
    input: {
      presetId?: string;
      text: string;
      voice?: string;
      format?: string;
    },
    options?: FullGatewayOptions,
  ): Promise<{
    audio: { mimeType: string; data: Uint8Array };
    warnings: readonly string[];
  }>;

  /** Optional — mirrors `PluginRuntimeGateway.transcribeAudio`. */
  transcribeAudio?(
    input: {
      presetId?: string;
      audio: { data: Uint8Array; mimeType: string; fileName?: string };
    },
    options?: FullGatewayOptions,
  ): Promise<{
    text: string;
    warnings: readonly string[];
  }>;
}

/**
 * Minimal "accept anything" schema marker. `ai-provider.generateObject`
 * expects a Zod schema; plugins pass a JSON-schema-ish object instead.
 * We bypass validation at the gateway layer by handing it a passthrough
 * Zod schema. Importing Zod statically here would couple @covel/runtime
 * to @covel/ai-provider's peer dep tree, so we accept an optional
 * `passthroughSchema` override the server can wire at startup.
 */
export interface PluginRuntimeGatewayConfig extends GatewayAdapterConfig {
  /**
   * Schema factory called per `generateObject()` invocation. Receives the
   * plugin-supplied JSON-schema record and must return something the
   * underlying gateway's `generateObject` accepts (usually a ZodType).
   * When omitted, the adapter rejects `generateObject` calls — agent
   * runtimes should be used instead.
   */
  readonly toZodSchema?: (
    jsonSchema: Readonly<Record<string, unknown>>,
  ) => ZodType<unknown>;
}

/**
 * Build a `PluginRuntimeGateway` facade from the full ai-provider gateway.
 * Used by server bootstrap to populate `TurnExecutorDeps.gateway`.
 */
export function createPluginRuntimeGateway(
  gateway: FullGatewayLike,
  config?: PluginRuntimeGatewayConfig,
): PluginRuntimeGateway {
  const commonOptions = () => ({
    ...(config?.apiKeys ? { apiKeys: config.apiKeys } : {}),
    ...(config?.envApiKeys ? { envApiKeys: config.envApiKeys } : {}),
    ...(config?.traceId ? { traceId: config.traceId } : {}),
    ...(config?.slotOverrides ? { slotOverrides: config.slotOverrides } : {}),
  });

  const facade: PluginRuntimeGateway = {
    async generateText(input) {
      const messages = input.messages
        ? input.messages.map((m) => ({ role: m.role, content: m.content }))
        : toMessages({
            system: input.system,
            prompt: input.prompt,
          });
      const result = await gateway.generateText(
        {
          ...(input.presetId ? { presetId: input.presetId } : {}),
          messages,
          ...(input.providerRequestMetadata
            ? { providerRequestMetadata: { ...input.providerRequestMetadata } }
            : {}),
        },
        {
          ...commonOptions(),
          ...(input.signal ? { signal: input.signal } : {}),
        },
      );
      return {
        text: result.text,
        finishReason: result.finishReason,
        usage: result.usage,
      };
    },

    async generateObject<T>(input: {
      readonly presetId?: string;
      readonly schema: Readonly<Record<string, unknown>>;
      readonly prompt?: string;
      readonly system?: string;
      readonly messages?: readonly {
        readonly role: "system" | "user" | "assistant";
        readonly content: string;
      }[];
      readonly providerRequestMetadata?: Readonly<Record<string, unknown>>;
      readonly signal?: AbortSignal;
    }): Promise<{
      readonly object: T;
      readonly finishReason: string;
      readonly usage: {
        readonly inputTokens: number;
        readonly outputTokens: number;
      };
    }> {
      if (!config?.toZodSchema) {
        throw new Error(
          [
            "PluginRuntimeGateway.generateObject is unavailable in this host.",
            "The framework intentionally ships without a JSON Schema → Zod",
            "converter injected: structured output for agent",
            "runtimes is already handled by the executor via `output.schema`",
            "and `responseFormat`, and no function-runtime caller needs this",
            "path yet. Prefer an agent runtime; if you genuinely need",
            "`generateObject` from a function runtime, open an issue so the",
            "composition root can install a converter.",
          ].join(" "),
        );
      }
      const zodSchema = config.toZodSchema(input.schema);
      const messages = input.messages
        ? input.messages.map((m) => ({ role: m.role, content: m.content }))
        : toMessages({ system: input.system, prompt: input.prompt });
      const result = await gateway.generateObject<T>(
        {
          ...(input.presetId ? { presetId: input.presetId } : {}),
          schema: zodSchema as ZodType<T>,
          messages,
          ...(input.providerRequestMetadata
            ? { providerRequestMetadata: { ...input.providerRequestMetadata } }
            : {}),
        },
        {
          ...commonOptions(),
          ...(input.signal ? { signal: input.signal } : {}),
        },
      );
      return {
        object: result.object,
        finishReason: result.finishReason,
        usage: result.usage,
      };
    },

    resolveSlot(input): ResolvedSlotForPlugin | null {
      const resolved = gateway.resolveSlot(input.presetId, {
        ...commonOptions(),
        ...(input.fallbackTag ? { fallbackTag: input.fallbackTag } : {}),
      });
      if (!resolved) return null;
      return {
        presetId: resolved.presetId,
        provider: resolved.provider,
        protocol: resolved.protocol,
        ...(resolved.baseUrl !== undefined
          ? { baseUrl: resolved.baseUrl }
          : {}),
        ...(resolved.apiKey !== undefined ? { apiKey: resolved.apiKey } : {}),
        ...(resolved.headers !== undefined
          ? { headers: { ...resolved.headers } }
          : {}),
        model: resolved.model,
        tag: resolved.tag,
        metadata: { ...resolved.metadata },
      };
    },
  };

  // Only exposed when the underlying gateway has an image wire registered
  // (audit D2/7) — `ctx.images` degrades to "unavailable" rather than
  // throwing through a stub method when no image slot is configured.
  if (gateway.generateImage) {
    const generateImage = gateway.generateImage.bind(gateway);
    facade.generateImage = async (input) => {
      const result = await generateImage(
        {
          presetId: input.presetId,
          prompt: input.prompt,
          negativePrompt: input.negativePrompt,
          size: input.size,
          quality: input.quality,
          n: input.n,
          background: input.background,
        },
        {
          ...commonOptions(),
          ...(input.signal ? { signal: input.signal } : {}),
        },
      );
      return { images: result.images, warnings: result.warnings };
    };
  }

  if (gateway.synthesizeSpeech) {
    const synthesizeSpeech = gateway.synthesizeSpeech.bind(gateway);
    facade.synthesizeSpeech = async (input) => {
      const result = await synthesizeSpeech(
        {
          presetId: input.presetId,
          text: input.text,
          voice: input.voice,
          format: input.format,
        },
        {
          ...commonOptions(),
          ...(input.signal ? { signal: input.signal } : {}),
        },
      );
      return { audio: result.audio, warnings: result.warnings };
    };
  }

  if (gateway.transcribeAudio) {
    const transcribeAudio = gateway.transcribeAudio.bind(gateway);
    facade.transcribeAudio = async (input) => {
      const result = await transcribeAudio(
        {
          presetId: input.presetId,
          audio: input.audio,
        },
        {
          ...commonOptions(),
          ...(input.signal ? { signal: input.signal } : {}),
        },
      );
      return { text: result.text, warnings: result.warnings };
    };
  }

  return facade;
}

function toMessages(opts: { system?: string; prompt?: string }): Array<{
  role: string;
  content: string | null;
}> {
  const messages: Array<{ role: string; content: string | null }> = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  if (opts.prompt) messages.push({ role: "user", content: opts.prompt });
  if (messages.length === 0) {
    throw new Error(
      "PluginRuntimeGateway call requires at least one of { prompt, system, messages }",
    );
  }
  return messages;
}
