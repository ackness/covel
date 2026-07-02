import type { ZodType } from "zod";

import { AiProviderError } from "./errors.js";
import type { ProviderResolution } from "./provider-registry.js";
import type { SlotRegistry } from "./slot-registry.js";
import { applySlotOverlay } from "./slot-overlay.js";
import {
  notifyStart,
  notifySuccess,
  targetModel,
  targetProvider,
} from "./gateway-lifecycle.js";
import {
  handleTargetFailure,
  prepareTarget,
} from "./gateway-fallback-chain.js";
import { createGatewaySlotResolution } from "./gateway-slot-resolution.js";
import type { GatewayOptions } from "./gateway-slot-resolution.js";
import { createRunOperation } from "./gateway-run-operation.js";
import { DEFAULT_IMAGE_WIRE, getImageWire } from "./image/wire-registry.js";
import type { ImageGenerationResult } from "./image/types.js";
import type {
  EmbeddingResult,
  OperationMode,
  PresetConfig,
  ProviderDefaults,
  ProviderConfig,
  ProviderProtocol,
  ResolvedTarget,
  SpeechSynthesisResult,
  StreamEvent,
  TextMessage,
  ToolDefinition,
  TranscriptionResult,
  UsageSummary,
} from "./types.js";

interface GatewayDependencies {
  providerRegistry: {
    resolve(
      target: {
        provider: string;
        baseUrl?: string;
        protocol?: ProviderProtocol;
      },
      options?: { mode: OperationMode },
    ): ProviderResolution;
    withApiKeys(
      resolution: ProviderResolution,
      apiKeys: Record<string, string>,
      providerName: string,
    ): ProviderResolution;
    // Overlay-capable methods — populated by the real createProviderRegistry.
    // Optional so structural test mocks don't need to implement them; when
    // absent, slotOverrides simply silently degrade to no-op.
    hasProvider?(name: string): boolean;
    addProvider?(name: string, defaults: ProviderDefaults): void;
    removeProvider?(name: string): void;
  };
  presetRegistry: {
    resolveTextTarget(input: { presetId?: string }): ResolvedTarget;
    resolveEmbeddingTarget(input?: { presetId?: string }): ResolvedTarget;
    resolveTextTargetChain(input: { presetId?: string }): ResolvedTarget[];
    hasPreset?(id: string): boolean;
    addPreset?(preset: PresetConfig): void;
    removePreset?(id: string): void;
  };
  slotRegistry?: SlotRegistry;
}

export type { GatewayOptions } from "./gateway-slot-resolution.js";

/**
 * Create the high-level AI gateway.
 *
 * Provides 7 operations with automatic fallback routing for text operations.
 */
export function createGateway(deps: GatewayDependencies) {
  /**
   * Tracks which (slot, fallbackTag) pairs we've already warned about so a
   * misconfigured runtime doesn't spam stderr every turn. The set lives in
   * gateway closure — reset on server restart.
   */
  const warnedFallbacks = new Set<string>();

  const { resolveSlotOrPassthrough, withPresetMetadata, resolveSlot } =
    createGatewaySlotResolution(deps, warnedFallbacks);

  const { runOperation } = createRunOperation(deps, resolveSlotOrPassthrough);

  async function generateText(
    input: {
      presetId?: string;
      messages: TextMessage[];
      tools?: ToolDefinition[];
      providerRequestMetadata?: Record<string, unknown>;
    },
    options?: GatewayOptions,
  ) {
    return runOperation(
      {
        presetId: input.presetId,
        mode: "text",
        fallbackTag: "text",
        resolveTargets: (presetId) =>
          deps.presetRegistry.resolveTextTargetChain({ presetId }),
        execute: async (target, resolved) =>
          resolved.adapter.generateText(
            configWithSignal(resolved.config, options),
            {
              model: targetModel(target),
              messages: input.messages,
              tools: input.tools,
              providerRequestMetadata: withPresetMetadata(
                target,
                input.providerRequestMetadata,
                input.presetId,
                options,
              ),
            },
            { profile: target.profile, preset: target.preset, mode: "text" },
          ),
        resolveUsage: (r) => r.usage,
      },
      options,
    );
  }

  async function generateObject<TObject>(
    input: {
      presetId?: string;
      schema: ZodType<TObject>;
      messages: TextMessage[];
      providerRequestMetadata?: Record<string, unknown>;
    },
    options?: GatewayOptions,
  ) {
    return runOperation(
      {
        presetId: input.presetId,
        // Object generation shares the text slot's fallback tag — the slot
        // resolver has no separate "object" tag.
        mode: "object",
        fallbackTag: "text",
        resolveTargets: (presetId) =>
          deps.presetRegistry.resolveTextTargetChain({ presetId }),
        execute: async (target, resolved) => {
          const result = await resolved.adapter.generateObject(
            configWithSignal(resolved.config, options),
            {
              model: targetModel(target),
              schema: input.schema,
              messages: input.messages,
              providerRequestMetadata: withPresetMetadata(
                target,
                input.providerRequestMetadata,
                input.presetId,
                options,
              ),
            },
            { profile: target.profile, preset: target.preset, mode: "object" },
          );
          return result as {
            object: TObject;
            finishReason: string;
            usage: UsageSummary;
          };
        },
        resolveUsage: (r) => r.usage,
      },
      options,
    );
  }

  async function* streamText(
    input: {
      presetId?: string;
      messages: TextMessage[];
      tools?: ToolDefinition[];
      providerRequestMetadata?: Record<string, unknown>;
    },
    options?: GatewayOptions,
  ): AsyncIterable<StreamEvent> {
    const cleanup = applySlotOverlay(deps, options?.slotOverrides);
    try {
      yield* streamTextInner(input, options);
    } finally {
      cleanup();
    }
  }

  async function* streamTextInner(
    input: {
      presetId?: string;
      messages: TextMessage[];
      tools?: ToolDefinition[];
      providerRequestMetadata?: Record<string, unknown>;
    },
    options?: GatewayOptions,
  ): AsyncIterable<StreamEvent> {
    const targets = deps.presetRegistry.resolveTextTargetChain({
      presetId: resolveSlotOrPassthrough(input.presetId, "text", options),
    });
    let lastError: AiProviderError | null = null;

    for (const [index, target] of targets.entries()) {
      const { provider, resolved } = prepareTarget(
        deps.providerRegistry,
        target,
        "stream",
        options,
      );

      let emittedDelta = false;
      const startTime = Date.now();

      try {
        await notifyStart(
          resolved.hooks,
          provider,
          resolved.protocol,
          "stream",
          targetModel(target),
          options?.traceId,
        );
        let finalUsage: UsageSummary | null = null;

        for await (const event of resolved.adapter.streamText(
          configWithSignal(resolved.config, options),
          {
            model: targetModel(target),
            messages: input.messages,
            tools: input.tools,
            providerRequestMetadata: withPresetMetadata(
              target,
              input.providerRequestMetadata,
              input.presetId,
              options,
            ),
          },
          { profile: target.profile, preset: target.preset, mode: "stream" },
        )) {
          if (
            (event.type === "text-delta" && event.textDelta.length > 0) ||
            (event.type === "reasoning-delta" &&
              event.reasoningDelta.length > 0)
          ) {
            emittedDelta = true;
          }
          if (event.type === "done") finalUsage = event.usage;
          yield event;
        }

        await notifySuccess(
          resolved.hooks,
          provider,
          resolved.protocol,
          "stream",
          targetModel(target),
          finalUsage,
          Date.now() - startTime,
          options?.traceId,
        );
        return;
      } catch (error) {
        // Once a delta has been emitted we can no longer retry on another
        // provider — the consumer has already seen partial output.
        lastError = await handleTargetFailure({
          error,
          resolved,
          provider,
          mode: "stream",
          target,
          startTime,
          options,
          canFallback: !emittedDelta && index < targets.length - 1,
        });
      }
    }

    if (lastError) throw lastError;
  }

  async function embed(
    input: {
      presetId?: string;
      values: string[];
      providerRequestMetadata?: Record<string, unknown>;
    },
    options?: GatewayOptions,
  ): Promise<EmbeddingResult> {
    if (!input.values?.length) {
      throw new AiProviderError({
        code: "CONFIG_ERROR",
        message: "embed() requires at least one value",
        provider: "unknown",
        retriable: false,
      });
    }

    return runOperation(
      {
        presetId: input.presetId,
        mode: "embed",
        fallbackTag: "embedding",
        resolveTargets: (presetId) => [
          deps.presetRegistry.resolveEmbeddingTarget({ presetId }),
        ],
        // Embed routes differently from the text path: via the preset (which
        // carries baseUrl/protocol) when available, else via the embed
        // profile's bare provider name — the provider registry fills in
        // baseUrl/protocol from its registered defaults. Request keys bind to
        // the profile provider.
        prepare: (target, opts) => {
          const routingTarget = target.preset ?? {
            provider: target.profile.provider,
          };
          let resolved = deps.providerRegistry.resolve(routingTarget, {
            mode: "embed",
          });
          if (opts?.apiKeys) {
            resolved = deps.providerRegistry.withApiKeys(
              resolved,
              opts.apiKeys,
              target.profile.provider,
            );
          }
          return { provider: targetProvider(target), resolved };
        },
        execute: async (target, resolved) => {
          // Merge slot-level embeddingFormat into the per-call metadata so the
          // adapter can dispatch (e.g. Nemotron multimodal wrapping).
          const providerRequestMetadata: Record<string, unknown> = {
            ...(target.preset?.embeddingFormat !== undefined
              ? { embeddingFormat: target.preset.embeddingFormat }
              : {}),
            ...input.providerRequestMetadata,
          };
          return resolved.adapter.embed(
            configWithSignal(resolved.config, options),
            {
              model: target.profile.model,
              values: input.values,
              providerRequestMetadata,
            },
            { profile: target.profile, preset: target.preset, mode: "embed" },
          );
        },
      },
      options,
    );
  }

  async function synthesizeSpeech(
    input: {
      presetId?: string;
      text: string;
      voice?: string;
      format?: string;
      providerRequestMetadata?: Record<string, unknown>;
    },
    options?: GatewayOptions,
  ): Promise<SpeechSynthesisResult> {
    return runOperation(
      {
        presetId: input.presetId,
        mode: "speech",
        fallbackTag: "speech",
        resolveTargets: (presetId) => [
          deps.presetRegistry.resolveTextTarget({ presetId }),
        ],
        execute: async (target, resolved) =>
          resolved.adapter.synthesizeSpeech(
            configWithSignal(resolved.config, options),
            {
              model: targetModel(target),
              text: input.text,
              ...(input.voice ? { voice: input.voice } : {}),
              ...(input.format ? { format: input.format } : {}),
              providerRequestMetadata: input.providerRequestMetadata,
            },
            { profile: target.profile, preset: target.preset, mode: "speech" },
          ),
      },
      options,
    );
  }

  async function transcribeAudio(
    input: {
      presetId?: string;
      audio: { data: Uint8Array; mimeType: string; fileName?: string };
      providerRequestMetadata?: Record<string, unknown>;
    },
    options?: GatewayOptions,
  ): Promise<TranscriptionResult> {
    return runOperation(
      {
        presetId: input.presetId,
        mode: "transcription",
        fallbackTag: "transcription",
        resolveTargets: (presetId) => [
          deps.presetRegistry.resolveTextTarget({ presetId }),
        ],
        execute: async (target, resolved) =>
          resolved.adapter.transcribeAudio(
            configWithSignal(resolved.config, options),
            {
              model: targetModel(target),
              audio: input.audio,
              providerRequestMetadata: input.providerRequestMetadata,
            },
            {
              profile: target.profile,
              preset: target.preset,
              mode: "transcription",
            },
          ),
      },
      options,
    );
  }

  async function generateImage(
    input: {
      presetId?: string;
      prompt: string;
      negativePrompt?: string;
      size?: string;
      quality?: string;
      n?: number;
      background?: "transparent" | "opaque";
      providerRequestMetadata?: Record<string, unknown>;
    },
    options?: GatewayOptions,
  ): Promise<ImageGenerationResult & { model: string; providerId: string }> {
    return runOperation(
      {
        presetId: input.presetId,
        mode: "image",
        fallbackTag: "image",
        resolveTargets: (presetId) => [
          deps.presetRegistry.resolveTextTarget({ presetId }),
        ],
        execute: async (target, resolved) => {
          const meta = target.preset?.providerRequestMetadata;
          const wireId =
            typeof meta?.imageWire === "string" && meta.imageWire
              ? meta.imageWire
              : DEFAULT_IMAGE_WIRE;
          const wire = getImageWire(wireId);
          if (!wire) {
            throw new Error(
              `unknown image wire "${wireId}" — register it via registerImageWire() or fix llm.toml providerRequestMetadata.imageWire`,
            );
          }
          const result = await wire.generate(
            configWithSignal(resolved.config, options),
            {
              model: targetModel(target),
              prompt: input.prompt,
              negativePrompt: input.negativePrompt,
              size: input.size,
              quality: input.quality,
              n: input.n,
              background: input.background,
              providerRequestMetadata: input.providerRequestMetadata,
            },
            { profile: target.profile, preset: target.preset, mode: "image" },
          );
          return {
            ...result,
            model: targetModel(target),
            providerId: targetProvider(target),
          };
        },
      },
      options,
    );
  }

  return {
    generateText,
    generateObject,
    streamText,
    embed,
    synthesizeSpeech,
    transcribeAudio,
    generateImage,
    resolveSlot,
  };

  // ── Internal helpers ─────────────────────────────────────────────

  /** Merge abort signal from gateway options into provider config. */
  function configWithSignal(
    config: ProviderConfig,
    options?: GatewayOptions,
  ): ProviderConfig {
    return options?.signal ? { ...config, signal: options.signal } : config;
  }
}
