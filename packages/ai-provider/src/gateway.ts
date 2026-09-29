import {
  assertLlmRequestBudget,
  createLlmRequestScope,
  iterateLlmRequest,
  type LLMResponseFormat,
  type LLMRequestDefaults,
  type LLMProviderWarning,
  type LLMRequestBudget,
} from "@covel/shared";
import type { ImageGenerationTarget } from "@covel/shared/plugin-runtime";
import type { ZodType } from "zod";
import type {
  EvaluationParams,
  EvaluationQuestions,
  EvaluationResult,
} from "./evaluation/types.js";

import { AiProviderError } from "./errors.js";
import {
  extractReasoningRequestFields,
  readReasoningEffort,
} from "./reasoning-effort.js";
import { projectCapabilityForBuiltinAdapter } from "./capability/adapter-support.js";
import {
  resolveProviderOptions,
  validateParameterMetadata,
  withProviderWarnings,
  type ProviderOptions,
} from "./provider-options.js";
import { assertSuccessfulFinishReason } from "./adapters/generation-completion.js";
import type { ProviderResolution } from "./provider-registry.js";
import type { SlotRegistry } from "./slot-registry.js";
import {
  applyRequestCapabilityOverlay,
  applySlotOverlay,
} from "./slot-overlay.js";
import {
  notifyStart,
  notifySuccess,
  notifyTargetAttempt,
  targetModel,
  targetProvider,
} from "./gateway-lifecycle.js";
import {
  handleTargetFailure,
  prepareTarget,
} from "./gateway-fallback-chain.js";
import {
  createGatewaySlotResolution,
  targetMetadata,
} from "./gateway-slot-resolution.js";
import type { GatewayOptions } from "./gateway-slot-resolution.js";
import { createRunOperation } from "./gateway-run-operation.js";
import { DEFAULT_IMAGE_WIRE, getImageWire } from "./image/wire-registry.js";
import type { ImageGenerationResult } from "./image/types.js";
import {
  DEFAULT_SPEECH_WIRE,
  DEFAULT_TRANSCRIPTION_WIRE,
  getSpeechWire,
  getTranscriptionWire,
} from "./speech/wire-registry.js";
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
  ModelRequestContext,
} from "./types.js";

function assertExplicitGoogleMediaWire(
  protocol: ProviderProtocol,
  wire: unknown,
  mode: "image" | "speech" | "transcription",
  provider: string,
): void {
  if (
    protocol === "google-generative-ai-v1" &&
    !(typeof wire === "string" && wire)
  ) {
    throw new AiProviderError({
      code: "CONFIG_ERROR",
      message: `Google native ${mode} generation requires an explicitly configured ${mode}Wire; the built-in Gemini adapter supports text generation only.`,
      provider,
      retriable: false,
    });
  }
}

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
      envApiKeys?: Record<string, string>,
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
 * Provides generation and evaluation operations with shared provider routing.
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

  function resolveTextTargets(
    presetId: string | undefined,
    options: GatewayOptions | undefined,
    requestedId?: string,
  ): ResolvedTarget[] {
    const primary = deps.presetRegistry.resolveTextTarget({ presetId });
    if (options?.allowFallback === false) return [primary];

    // Fallback belongs to the requested role, independent of its selected model.
    // Resolve each fallback role through this request's bindings as well.
    const roles = Object.values(deps.slotRegistry?.listSlots() ?? {});
    const baseId = requestedId
      ? deps.slotRegistry?.resolveSlot(requestedId)
      : undefined;
    const policy = deps.presetRegistry.resolveTextTargetChain({
      presetId: baseId ?? presetId,
    });
    const seen = new Set([primary.preset?.id]);
    const targets = [primary];
    for (const fallback of policy.slice(1)) {
      const role = roles.find((slot) => slot.presetId === fallback.preset?.id);
      const id = role
        ? resolveSlotOrPassthrough(role.slotId, role.tag, options)
        : fallback.preset?.id;
      const target = deps.presetRegistry.resolveTextTarget({ presetId: id });
      if (seen.has(target.preset?.id)) continue;
      seen.add(target.preset?.id);
      targets.push(target);
    }
    return targets;
  }

  async function evaluate<const Q extends EvaluationQuestions>(
    input: Omit<EvaluationParams<Q>, "model"> & { presetId?: string },
    options?: GatewayOptions,
  ): Promise<EvaluationResult<Q> & { provider: string }> {
    return runOperation(
      {
        presetId: input.presetId ?? "evaluation",
        mode: "evaluate",
        fallbackTag: "evaluation",
        resolveTargets: (presetId) =>
          resolveTextTargets(presetId, options, input.presetId ?? "evaluation"),
        execute: async (target, resolved) => {
          options?.signal?.throwIfAborted();
          const modes =
            target.preset?.supportedModes ?? target.profile.supportedModes;
          if (!modes.includes("evaluate") || !resolved.adapter.evaluate) {
            throw new AiProviderError({
              code: "CONFIG_ERROR",
              message: "Selected model does not support evaluation.",
              provider: targetProvider(target),
              model: targetModel(target),
              retriable: false,
            });
          }
          const result = await resolved.adapter.evaluate(
            configWithSignal(resolved.config, options, {
              provider: targetProvider(target),
              protocol: resolved.protocol,
            }),
            {
              model: targetModel(target),
              state: input.state,
              questions: input.questions,
            },
            {
              profile: target.profile,
              preset: target.preset,
              mode: "evaluate",
            },
          );
          return { ...result, provider: targetProvider(target) };
        },
        resolveUsage: (result) => result.usage,
      },
      options,
    );
  }

  async function generateText(
    input: {
      presetId?: string;
      messages: TextMessage[];
      tools?: ToolDefinition[];
      defaults?: LLMRequestDefaults;
      responseFormat?: LLMResponseFormat;
      providerRequestMetadata?: Record<string, unknown>;
      providerOptions?: ProviderOptions;
    },
    options?: GatewayOptions,
  ) {
    let metadataTarget: string | undefined;
    return runOperation(
      {
        presetId: input.presetId,
        mode: "text",
        fallbackTag: "text",
        resolveTargets: (presetId) =>
          resolveTextTargets(presetId, options, input.presetId),
        execute: async (target, resolved) => {
          metadataTarget ??= metadataTargetIdentity(target, resolved);
          const request = prepareTextMetadata(
            target,
            resolved,
            input,
            options,
            metadataTarget,
          );
          const result = await resolved.adapter.generateText(
            configWithSignal(resolved.config, options, {
              provider: targetProvider(target),
              protocol: resolved.protocol,
            }),
            {
              model: targetModel(target),
              messages: input.messages,
              tools: input.tools,
              defaults: input.defaults,
              responseFormat: input.responseFormat,
              providerRequestMetadata: request.metadata,
            },
            textContext(target, resolved, "text"),
          );
          assertSuccessfulFinishReason(
            result.finishReason,
            targetProvider(target),
          );
          return {
            ...withProviderWarnings(result, request.warnings),
            model: targetModel(target),
            provider: targetProvider(target),
          };
        },
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
      providerOptions?: ProviderOptions;
    },
    options?: GatewayOptions,
  ) {
    let metadataTarget: string | undefined;
    return runOperation(
      {
        presetId: input.presetId,
        // Object generation shares the text slot's fallback tag — the slot
        // resolver has no separate "object" tag.
        mode: "object",
        fallbackTag: "text",
        resolveTargets: (presetId) =>
          resolveTextTargets(presetId, options, input.presetId),
        execute: async (target, resolved) => {
          metadataTarget ??= metadataTargetIdentity(target, resolved);
          const request = prepareTextMetadata(
            target,
            resolved,
            input,
            options,
            metadataTarget,
          );
          const result = await resolved.adapter.generateObject(
            configWithSignal(resolved.config, options, {
              provider: targetProvider(target),
              protocol: resolved.protocol,
            }),
            {
              model: targetModel(target),
              schema: input.schema,
              messages: input.messages,
              providerRequestMetadata: request.metadata,
            },
            textContext(target, resolved, "object"),
          );
          assertSuccessfulFinishReason(
            result.finishReason,
            targetProvider(target),
          );
          return {
            ...withProviderWarnings(result, request.warnings),
            model: targetModel(target),
            provider: targetProvider(target),
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
      defaults?: LLMRequestDefaults;
      responseFormat?: LLMResponseFormat;
      providerRequestMetadata?: Record<string, unknown>;
      providerOptions?: ProviderOptions;
    },
    options?: GatewayOptions,
  ): AsyncIterable<StreamEvent> {
    const scope = createLlmRequestScope({
      budget: options?.requestBudget,
      signal: options?.signal,
    });
    let cleanup = () => {};
    try {
      cleanup = applySlotOverlay(deps, options?.slotOverrides);
      yield* streamTextInner(input, {
        ...options,
        requestBudget: scope.budget,
        signal: scope.signal,
      });
    } finally {
      cleanup();
      scope.dispose();
    }
  }

  async function* streamTextInner(
    input: {
      presetId?: string;
      messages: TextMessage[];
      tools?: ToolDefinition[];
      defaults?: LLMRequestDefaults;
      responseFormat?: LLMResponseFormat;
      providerRequestMetadata?: Record<string, unknown>;
      providerOptions?: ProviderOptions;
    },
    options: GatewayOptions & {
      signal: AbortSignal;
      requestBudget: LLMRequestBudget;
    },
  ): AsyncIterable<StreamEvent> {
    const targets = resolveTextTargets(
      resolveSlotOrPassthrough(input.presetId, "text", options),
      options,
      input.presetId,
    ).map((target, index) =>
      applyRequestCapabilityOverlay(
        target,
        input.presetId,
        options?.slotOverrides,
        options?.capabilityOverridePolicy ?? "restrict-only",
        index === 0,
      ),
    );
    let lastError: AiProviderError | null = null;
    let metadataTarget: string | undefined;

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
        if (options?.requestBudget)
          assertLlmRequestBudget(options.requestBudget, {
            signal: options.signal,
            requireAttempt: true,
          });
        metadataTarget ??= metadataTargetIdentity(target, resolved);
        const request = prepareTextMetadata(
          target,
          resolved,
          input,
          options,
          metadataTarget,
        );
        notifyTargetAttempt(options?.onTargetAttempt, target);
        await notifyStart(
          resolved.hooks,
          provider,
          resolved.protocol,
          "stream",
          targetModel(target),
          options?.traceId,
          options,
        );
        let completion: Extract<StreamEvent, { type: "done" }> | undefined;

        for await (const event of iterateLlmRequest(
          resolved.adapter.streamText(
            configWithSignal(resolved.config, options, {
              provider: targetProvider(target),
              protocol: resolved.protocol,
            }),
            {
              model: targetModel(target),
              messages: input.messages,
              tools: input.tools,
              defaults: input.defaults,
              responseFormat: input.responseFormat,
              providerRequestMetadata: request.metadata,
            },
            textContext(target, resolved, "stream"),
          ),
          options?.signal,
        )) {
          if (
            (event.type === "text-delta" && event.textDelta.length > 0) ||
            (event.type === "reasoning-delta" &&
              event.reasoningDelta.length > 0) ||
            event.type === "tool-call"
          ) {
            emittedDelta = true;
          }
          if (event.type === "done") {
            assertSuccessfulFinishReason(event.finishReason, provider);
            completion = withProviderWarnings(event, request.warnings);
            continue;
          }
          yield event;
        }

        if (!completion) {
          throw new AiProviderError({
            code: "PROVIDER_ERROR",
            message: "Provider stream ended without a done event",
            provider,
            model: targetModel(target),
            retriable: true,
          });
        }

        await notifySuccess(
          resolved.hooks,
          provider,
          resolved.protocol,
          "stream",
          targetModel(target),
          completion.usage,
          Date.now() - startTime,
          options?.traceId,
          options,
        );
        yield completion;
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
      /** Reject configuration drift before sending vectors to a locked index. */
      expectedModelId?: string;
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
        resolveTargets: (presetId) => {
          const target = deps.presetRegistry.resolveEmbeddingTarget({
            presetId,
          });
          const modelId = `${target.profile.provider}/${target.profile.model}`;
          if (
            input.expectedModelId !== undefined &&
            input.expectedModelId !== modelId
          ) {
            throw new AiProviderError({
              code: "CONFIG_ERROR",
              message: `Embedding model changed: expected ${input.expectedModelId}, resolved ${modelId}`,
              provider: target.profile.provider,
              model: target.profile.model,
              retriable: false,
            });
          }
          return [target];
        },
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
          if (opts?.apiKeys || opts?.envApiKeys) {
            resolved = deps.providerRegistry.withApiKeys(
              resolved,
              opts.apiKeys ?? {},
              target.profile.provider,
              opts.envApiKeys,
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
  ): Promise<SpeechSynthesisResult & { model: string; provider: string }> {
    return runOperation(
      {
        // Default to the conventional "speech" slot so an omitted presetId
        // enters the named-slot → speech-tag fallback chain instead of
        // passing `undefined` through to the default (text) slot.
        presetId: input.presetId ?? "speech",
        mode: "speech",
        fallbackTag: "speech",
        resolveTargets: (presetId) => [
          deps.presetRegistry.resolveTextTarget({ presetId }),
        ],
        execute: async (target, resolved) => {
          const slotMeta = target.preset?.providerRequestMetadata;
          assertExplicitGoogleMediaWire(
            resolved.protocol,
            slotMeta?.speechWire,
            "speech",
            targetProvider(target),
          );
          const wireId =
            typeof slotMeta?.speechWire === "string" && slotMeta.speechWire
              ? slotMeta.speechWire
              : DEFAULT_SPEECH_WIRE;
          const wire = getSpeechWire(wireId);
          if (!wire) {
            throw new AiProviderError({
              code: "CONFIG_ERROR",
              message: `unknown speech wire "${wireId}" — register it via registerSpeechWire() or fix llm.toml providerRequestMetadata.speechWire`,
              provider: targetProvider(target),
              retriable: false,
            });
          }
          const result = await wire.synthesize(
            configWithSignal(resolved.config, options),
            {
              model: targetModel(target),
              text: input.text,
              ...(input.voice ? { voice: input.voice } : {}),
              ...(input.format ? { format: input.format } : {}),
              // Per-call metadata overrides slot defaults. Not routed through
              // withPresetMetadata — that also folds in parameterOverrides,
              // which are text-generation params that don't belong in a
              // speech request body.
              providerRequestMetadata: {
                ...slotMeta,
                ...input.providerRequestMetadata,
              },
            },
            { profile: target.profile, preset: target.preset, mode: "speech" },
          );
          return {
            ...result,
            model: targetModel(target),
            provider: targetProvider(target),
          };
        },
        resolveUsage: (r) => r.usage,
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
  ): Promise<TranscriptionResult & { model: string; provider: string }> {
    return runOperation(
      {
        presetId: input.presetId ?? "transcription",
        mode: "transcription",
        fallbackTag: "transcription",
        resolveTargets: (presetId) => [
          deps.presetRegistry.resolveTextTarget({ presetId }),
        ],
        execute: async (target, resolved) => {
          const slotMeta = target.preset?.providerRequestMetadata;
          assertExplicitGoogleMediaWire(
            resolved.protocol,
            slotMeta?.transcriptionWire,
            "transcription",
            targetProvider(target),
          );
          const wireId =
            typeof slotMeta?.transcriptionWire === "string" &&
            slotMeta.transcriptionWire
              ? slotMeta.transcriptionWire
              : DEFAULT_TRANSCRIPTION_WIRE;
          const wire = getTranscriptionWire(wireId);
          if (!wire) {
            throw new AiProviderError({
              code: "CONFIG_ERROR",
              message: `unknown transcription wire "${wireId}" — register it via registerTranscriptionWire() or fix llm.toml providerRequestMetadata.transcriptionWire`,
              provider: targetProvider(target),
              retriable: false,
            });
          }
          const result = await wire.transcribe(
            configWithSignal(resolved.config, options),
            {
              model: targetModel(target),
              audio: input.audio,
              providerRequestMetadata: {
                ...slotMeta,
                ...input.providerRequestMetadata,
              },
            },
            {
              profile: target.profile,
              preset: target.preset,
              mode: "transcription",
            },
          );
          return {
            ...result,
            model: targetModel(target),
            provider: targetProvider(target),
          };
        },
        resolveUsage: (r) => r.usage,
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
  ): Promise<
    ImageGenerationResult & {
      model: string;
      provider: string;
      target: ImageGenerationTarget;
    }
  > {
    return runOperation(
      {
        // The image role is an exact binding, independent of the text default.
        presetId: input.presetId ?? "image",
        mode: "image",
        fallbackTag: "image",
        resolveTargets: (presetId) => [
          deps.presetRegistry.resolveTextTarget({ presetId }),
        ],
        execute: async (target, resolved) => {
          const slotMeta = target.preset?.providerRequestMetadata;
          assertExplicitGoogleMediaWire(
            resolved.protocol,
            slotMeta?.imageWire,
            "image",
            targetProvider(target),
          );
          const wireId =
            typeof slotMeta?.imageWire === "string" && slotMeta.imageWire
              ? slotMeta.imageWire
              : DEFAULT_IMAGE_WIRE;
          const wire = getImageWire(wireId);
          if (!wire) {
            throw new AiProviderError({
              code: "CONFIG_ERROR",
              message: `unknown image wire "${wireId}" — register it via registerImageWire() or fix llm.toml providerRequestMetadata.imageWire`,
              provider: targetProvider(target),
              retriable: false,
            });
          }
          const generationTarget: ImageGenerationTarget = {
            provider: targetProvider(target),
            model: targetModel(target),
            protocol: target.preset?.protocol ?? resolved.protocol,
            baseUrl: resolved.config.baseUrl ?? target.preset?.baseUrl,
            metadata: structuredClone(targetMetadata(target)),
          };
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
              // Per-call metadata overrides slot defaults. Not routed through
              // withPresetMetadata — that also folds in parameterOverrides,
              // which are text-generation params that don't belong in an
              // image request body.
              providerRequestMetadata: {
                ...slotMeta,
                ...input.providerRequestMetadata,
              },
            },
            { profile: target.profile, preset: target.preset, mode: "image" },
          );
          return {
            ...result,
            target: generationTarget,
            model: targetModel(target),
            provider: targetProvider(target),
          };
        },
        resolveUsage: (r) => r.usage,
      },
      options,
    );
  }

  return {
    evaluate,
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

  function metadataTargetIdentity(
    target: ResolvedTarget,
    resolved: ProviderResolution,
  ): string {
    return JSON.stringify([
      targetProvider(target),
      resolved.protocol,
      resolved.config.baseUrl ?? null,
    ]);
  }

  function textContext(
    target: ResolvedTarget,
    resolved: ProviderResolution,
    mode: "text" | "object" | "stream",
  ): ModelRequestContext {
    const preset = target.preset;
    return {
      profile: target.profile,
      preset:
        resolved.usesBuiltinAdapter && preset?.capability
          ? {
              ...preset,
              capability: projectCapabilityForBuiltinAdapter(
                preset.capability,
                resolved.protocol,
                "text",
              ),
            }
          : preset,
      mode,
    };
  }

  function prepareTextMetadata(
    target: ResolvedTarget,
    resolved: ProviderResolution,
    input: {
      presetId?: string;
      providerRequestMetadata?: Record<string, unknown>;
      providerOptions?: ProviderOptions;
    },
    options: GatewayOptions | undefined,
    metadataTarget: string,
  ): { metadata: Record<string, unknown>; warnings: LLMProviderWarning[] } {
    const provider = targetProvider(target);
    const presetOptions = resolveProviderOptions(
      target.preset?.providerOptions,
      provider,
      resolved.protocol,
    );
    const callOptions = resolveProviderOptions(
      input.providerOptions,
      provider,
      resolved.protocol,
    );
    const warnings = [...presetOptions.warnings, ...callOptions.warnings];
    let callMetadata = input.providerRequestMetadata;
    if (
      metadataTarget !== metadataTargetIdentity(target, resolved) &&
      callMetadata
    ) {
      // Unscoped wire extensions belong to the original target. Portable
      // generation settings can cross providers; native fields cannot.
      const { parameterOverrides, ...native } = callMetadata;
      callMetadata =
        parameterOverrides === undefined ? {} : { parameterOverrides };
      if (Object.keys(native).length)
        warnings.push({
          type: "compatibility",
          feature: "providerRequestMetadata",
          message:
            "Unscoped provider metadata was omitted after fallback changed the provider, protocol or endpoint. Use providerOptions to configure each target.",
        });
    }
    const metadata =
      withPresetMetadata(
        target,
        { ...callMetadata, ...callOptions.metadata },
        input.presetId,
        options,
        {
          ...target.preset?.providerRequestMetadata,
          ...presetOptions.metadata,
        },
      ) ?? {};
    warnings.push(
      ...validateParameterMetadata(metadata, provider, resolved.protocol),
    );
    const reasoningEffort = readReasoningEffort(metadata);
    if (
      resolved.usesBuiltinAdapter &&
      reasoningEffort &&
      reasoningEffort !== "provider-default" &&
      Object.keys(
        extractReasoningRequestFields(
          metadata,
          textContext(target, resolved, "text"),
          resolved.protocol,
          targetModel(target),
        ),
      ).length === 0
    ) {
      warnings.push({
        type: "unsupported",
        feature: "reasoningEffort",
        message:
          "The selected model does not use this reasoning effort setting; the provider default applies.",
      });
    }
    return { metadata, warnings };
  }

  /** Merge abort signal from gateway options into provider config. */
  function configWithSignal(
    config: ProviderConfig,
    options?: GatewayOptions,
    requestTarget?: { provider: string; protocol: string },
  ): ProviderConfig {
    return {
      ...config,
      ...(options?.signal
        ? {
            signal:
              config.signal && config.signal !== options.signal
                ? AbortSignal.any([config.signal, options.signal])
                : options.signal,
          }
        : {}),
      requestBudget: options?.requestBudget ?? config.requestBudget,
      ...(requestTarget && options?.onProviderRequest
        ? {
            requestObservation: {
              ...requestTarget,
              onRequest: options.onProviderRequest,
            },
          }
        : {}),
    };
  }
}
