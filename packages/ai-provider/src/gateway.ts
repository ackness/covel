import type { ZodType } from "zod";

import { AiProviderError } from "./errors.js";
import type { ProviderResolution } from "./provider-registry.js";
import type { SlotRegistry } from "./slot-registry.js";
import { applySlotOverlay } from "./slot-overlay.js";
import {
  normalizeError,
  notifyError,
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

  const {
    resolveSlotOrPassthrough,
    resolveSlotToPresetId,
    getSlotParameterOverrides,
    withPresetMetadata,
    resolveSlot,
  } = createGatewaySlotResolution(deps, warnedFallbacks);

  async function generateText(
    input: {
      presetId?: string;
      messages: TextMessage[];
      tools?: ToolDefinition[];
      providerRequestMetadata?: Record<string, unknown>;
    },
    options?: GatewayOptions,
  ) {
    return runWithFallback(
      { presetId: input.presetId },
      "text",
      options,
      async (target, resolved) =>
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
      (r) => r.usage,
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
    return runWithFallback(
      { presetId: input.presetId },
      "object",
      options,
      async (target, resolved) => {
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
      (r) => r.usage,
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

    const cleanup = applySlotOverlay(deps, options?.slotOverrides);
    try {
      return await embedInner(input, options);
    } finally {
      cleanup();
    }
  }

  async function embedInner(
    input: {
      presetId?: string;
      values: string[];
      providerRequestMetadata?: Record<string, unknown>;
    },
    options?: GatewayOptions,
  ): Promise<EmbeddingResult> {
    const target = deps.presetRegistry.resolveEmbeddingTarget({
      presetId: resolveSlotOrPassthrough(input.presetId, "embedding", options),
    });

    // Route via the preset (carries baseUrl/protocol) when available, else
    // via the embed profile's provider name — the provider registry fills
    // in baseUrl/protocol from its registered provider defaults.
    const routingTarget = target.preset ?? {
      provider: target.profile.provider,
    };
    let resolved = deps.providerRegistry.resolve(routingTarget, {
      mode: "embed",
    });
    if (options?.apiKeys) {
      resolved = deps.providerRegistry.withApiKeys(
        resolved,
        options.apiKeys,
        target.profile.provider,
      );
    }

    // Merge slot-level embeddingFormat into the per-call metadata so the
    // adapter can dispatch (e.g. Nemotron multimodal wrapping).
    const providerRequestMetadata: Record<string, unknown> = {
      ...(target.preset?.embeddingFormat !== undefined
        ? { embeddingFormat: target.preset.embeddingFormat }
        : {}),
      ...input.providerRequestMetadata,
    };

    return runSingle(target, "embed", resolved, options, async () =>
      resolved.adapter.embed(
        configWithSignal(resolved.config, options),
        {
          model: target.profile.model,
          values: input.values,
          providerRequestMetadata,
        },
        { profile: target.profile, preset: target.preset, mode: "embed" },
      ),
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
    return runSingleFromPreset(
      input.presetId,
      "speech",
      options,
      (target, resolved) =>
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
    return runSingleFromPreset(
      input.presetId,
      "transcription",
      options,
      (target, resolved) =>
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
    );
  }

  return {
    generateText,
    generateObject,
    streamText,
    embed,
    synthesizeSpeech,
    transcribeAudio,
    resolveSlotToPresetId,
    getSlotParameterOverrides,
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

  async function runWithFallback<TResult>(
    input: { presetId?: string },
    mode: "text" | "object",
    options: GatewayOptions | undefined,
    execute: (
      target: ResolvedTarget,
      resolved: ProviderResolution,
    ) => Promise<TResult>,
    resolveUsage: (result: TResult) => UsageSummary | null,
  ): Promise<TResult> {
    const cleanup = applySlotOverlay(deps, options?.slotOverrides);
    try {
      return await runWithFallbackInner(
        input,
        mode,
        options,
        execute,
        resolveUsage,
      );
    } finally {
      cleanup();
    }
  }

  async function runWithFallbackInner<TResult>(
    input: { presetId?: string },
    mode: "text" | "object",
    options: GatewayOptions | undefined,
    execute: (
      target: ResolvedTarget,
      resolved: ProviderResolution,
    ) => Promise<TResult>,
    resolveUsage: (result: TResult) => UsageSummary | null,
  ): Promise<TResult> {
    const targets = deps.presetRegistry.resolveTextTargetChain({
      presetId: resolveSlotOrPassthrough(input.presetId, "text", options),
    });
    let lastError: AiProviderError | null = null;

    for (const [index, target] of targets.entries()) {
      const { provider, resolved } = prepareTarget(
        deps.providerRegistry,
        target,
        mode,
        options,
      );

      const startTime = Date.now();

      try {
        await notifyStart(
          resolved.hooks,
          provider,
          resolved.protocol,
          mode,
          targetModel(target),
          options?.traceId,
        );
        const result = await execute(target, resolved);
        await notifySuccess(
          resolved.hooks,
          provider,
          resolved.protocol,
          mode,
          targetModel(target),
          resolveUsage(result),
          Date.now() - startTime,
          options?.traceId,
        );
        return result;
      } catch (error) {
        lastError = await handleTargetFailure({
          error,
          resolved,
          provider,
          mode,
          target,
          startTime,
          options,
          canFallback: index < targets.length - 1,
        });
      }
    }

    throw (
      lastError ??
      new AiProviderError({
        code: "PROVIDER_ERROR",
        message: "No model target resolved.",
        provider: "unknown",
        retriable: false,
      })
    );
  }

  async function runSingleFromPreset<TResult>(
    presetId: string | undefined,
    mode: OperationMode,
    options: GatewayOptions | undefined,
    execute: (
      target: ResolvedTarget,
      resolved: ProviderResolution,
    ) => Promise<TResult>,
    fallbackTag?: string,
  ): Promise<TResult> {
    const cleanup = applySlotOverlay(deps, options?.slotOverrides);
    try {
      // Map mode → default fallback tag when the caller didn't pick one.
      // image/audio/speech operations must NOT silently fall back to text.
      const tag =
        fallbackTag ??
        (mode === "image"
          ? "image"
          : mode === "speech" || mode === "transcription"
            ? mode
            : "text");
      const target = deps.presetRegistry.resolveTextTarget({
        presetId: resolveSlotOrPassthrough(presetId, tag, options),
      });
      let resolved = deps.providerRegistry.resolve(
        target.preset ?? target.profile,
        { mode },
      );
      if (options?.apiKeys) {
        resolved = deps.providerRegistry.withApiKeys(
          resolved,
          options.apiKeys,
          targetProvider(target),
        );
      }

      return await runSingle(target, mode, resolved, options, () =>
        execute(target, resolved),
      );
    } finally {
      cleanup();
    }
  }

  async function runSingle<TResult>(
    target: ResolvedTarget,
    mode: OperationMode,
    resolved: ProviderResolution,
    options: GatewayOptions | undefined,
    execute: () => Promise<TResult>,
  ): Promise<TResult> {
    const provider = targetProvider(target);
    const model = targetModel(target);
    const startTime = Date.now();

    try {
      await notifyStart(
        resolved.hooks,
        provider,
        resolved.protocol,
        mode,
        model,
        options?.traceId,
      );
      const result = await execute();
      await notifySuccess(
        resolved.hooks,
        provider,
        resolved.protocol,
        mode,
        model,
        null,
        Date.now() - startTime,
        options?.traceId,
      );
      return result;
    } catch (error) {
      await notifyError(
        resolved.hooks,
        provider,
        resolved.protocol,
        mode,
        model,
        error,
        Date.now() - startTime,
        options?.traceId,
      );
      throw normalizeError(error, provider);
    }
  }
}
