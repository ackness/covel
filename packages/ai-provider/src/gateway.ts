import type { ZodType } from "zod";

import { AiProviderError } from "./errors.js";
import type { ProviderResolution } from "./provider-registry.js";
import type { SlotRegistry } from "./slot-registry.js";
import type {
  EmbeddingResult,
  ImageGenerationResult,
  ModelParameterOverrides,
  OperationMode,
  PresetConfig,
  ProviderConfig,
  ProviderLifecycleHook,
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
      target: { provider: string; baseUrl?: string; protocol?: ProviderProtocol },
      options?: { mode: OperationMode }
    ): ProviderResolution;
    withApiKeys(
      resolution: ProviderResolution,
      apiKeys: Record<string, string>,
      providerName: string
    ): ProviderResolution;
  };
  presetRegistry: {
    resolveTextTarget(input: { presetId?: string }): ResolvedTarget;
    resolveEmbeddingTarget(): ResolvedTarget;
    resolveTextTargetChain(input: { presetId?: string }): ResolvedTarget[];
  };
  slotRegistry?: SlotRegistry;
}

export interface GatewayOptions {
  /** Runtime API keys from request header. */
  apiKeys?: Record<string, string>;
  /** Trace ID for observability. */
  traceId?: string;
  /** Slot-level parameter overrides resolved from the slot registry. */
  parameterOverrides?: ModelParameterOverrides;
  /** Abort signal for cancellation (e.g. budget timeout). */
  signal?: AbortSignal;
}

/**
 * Create the high-level AI gateway.
 *
 * Provides 7 operations with automatic fallback routing for text operations.
 */
export function createGateway(deps: GatewayDependencies) {
  async function generateText(
    input: {
      presetId?: string;
      messages: TextMessage[];
      tools?: ToolDefinition[];
      providerRequestMetadata?: Record<string, unknown>;
    },
    options?: GatewayOptions
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
            providerRequestMetadata: input.providerRequestMetadata,
          },
          { profile: target.profile, preset: target.preset, mode: "text" }
        ),
      (r) => r.usage
    );
  }

  async function generateObject<TObject>(
    input: {
      presetId?: string;
      schema: ZodType<TObject>;
      messages: TextMessage[];
      providerRequestMetadata?: Record<string, unknown>;
    },
    options?: GatewayOptions
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
            providerRequestMetadata: input.providerRequestMetadata,
          },
          { profile: target.profile, preset: target.preset, mode: "object" }
        );
        return result as {
          object: TObject;
          finishReason: string;
          usage: UsageSummary;
        };
      },
      (r) => r.usage
    );
  }

  async function* streamText(
    input: {
      presetId?: string;
      messages: TextMessage[];
      providerRequestMetadata?: Record<string, unknown>;
    },
    options?: GatewayOptions
  ): AsyncIterable<StreamEvent> {
    const targets = deps.presetRegistry.resolveTextTargetChain({
      presetId: input.presetId,
    });
    let lastError: AiProviderError | null = null;

    for (const [index, target] of targets.entries()) {
      const provider = targetProvider(target);
      let resolved = deps.providerRegistry.resolve(
        target.preset ?? target.profile,
        { mode: "stream" }
      );
      if (options?.apiKeys) {
        resolved = deps.providerRegistry.withApiKeys(
          resolved,
          options.apiKeys,
          provider
        );
      }

      let emittedDelta = false;
      const startTime = Date.now();

      try {
        await notifyStart(resolved.hooks, provider, resolved.protocol, "stream", targetModel(target), options?.traceId);
        let finalUsage: UsageSummary | null = null;

        for await (const event of resolved.adapter.streamText(
          configWithSignal(resolved.config, options),
          {
            model: targetModel(target),
            messages: input.messages,
            providerRequestMetadata: input.providerRequestMetadata,
          },
          { profile: target.profile, preset: target.preset, mode: "stream" }
        )) {
          if (
            (event.type === "text-delta" && event.textDelta.length > 0) ||
            (event.type === "reasoning-delta" && event.reasoningDelta.length > 0)
          ) {
            emittedDelta = true;
          }
          if (event.type === "done") finalUsage = event.usage;
          yield event;
        }

        await notifySuccess(resolved.hooks, provider, resolved.protocol, "stream", targetModel(target), finalUsage, Date.now() - startTime, options?.traceId);
        return;
      } catch (error) {
        await notifyError(resolved.hooks, provider, resolved.protocol, "stream", targetModel(target), error, Date.now() - startTime, options?.traceId);
        const normalized = normalizeError(error, provider);
        lastError = normalized;

        if (
          emittedDelta ||
          index === targets.length - 1 ||
          !shouldFallback(normalized)
        ) {
          throw normalized;
        }
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
    options?: GatewayOptions
  ): Promise<EmbeddingResult> {
    if (!input.values?.length) {
      throw new AiProviderError({
        code: "CONFIG_ERROR",
        message: "embed() requires at least one value",
        provider: "unknown",
        retriable: false,
      });
    }

    const target = deps.presetRegistry.resolveEmbeddingTarget();
    // Use text target's provider config for embed routing
    const textTarget = deps.presetRegistry.resolveTextTarget({
      presetId: input.presetId,
    });
    const resolvedProvider = targetProvider(textTarget);
    let resolved = deps.providerRegistry.resolve(
      textTarget.preset ?? target.profile,
      { mode: "embed" }
    );
    if (options?.apiKeys) {
      resolved = deps.providerRegistry.withApiKeys(
        resolved,
        options.apiKeys,
        resolvedProvider
      );
    }

    return runSingle(
      target,
      "embed",
      resolved,
      options,
      async () =>
        resolved.adapter.embed(
          configWithSignal(resolved.config, options),
          {
            model: target.profile.model,
            values: input.values,
            providerRequestMetadata: input.providerRequestMetadata,
          },
          { profile: target.profile, preset: target.preset, mode: "embed" }
        )
    );
  }

  async function generateImage(
    input: {
      presetId?: string;
      prompt: string;
      providerRequestMetadata?: Record<string, unknown>;
    },
    options?: GatewayOptions
  ): Promise<ImageGenerationResult> {
    return runSingleFromPreset(
      input.presetId,
      "image",
      options,
      (target, resolved) =>
        resolved.adapter.generateImage(
          configWithSignal(resolved.config, options),
          {
            model: targetModel(target),
            prompt: input.prompt,
            providerRequestMetadata: input.providerRequestMetadata,
          },
          { profile: target.profile, preset: target.preset, mode: "image" }
        )
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
    options?: GatewayOptions
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
          { profile: target.profile, preset: target.preset, mode: "speech" }
        )
    );
  }

  async function transcribeAudio(
    input: {
      presetId?: string;
      audio: { data: Uint8Array; mimeType: string; fileName?: string };
      providerRequestMetadata?: Record<string, unknown>;
    },
    options?: GatewayOptions
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
          }
        )
    );
  }

  /**
   * Resolve a slot ID to a preset ID via the slot registry.
   * Returns undefined if no slot registry is configured or slot cannot be resolved.
   */
  function resolveSlotToPresetId(slotId: string): string | undefined {
    return deps.slotRegistry?.resolveSlot(slotId);
  }

  /**
   * Get parameter overrides for a given slot ID.
   */
  function getSlotParameterOverrides(slotId: string): ModelParameterOverrides | undefined {
    return deps.slotRegistry?.getParameterOverrides(slotId);
  }

  return {
    generateText,
    generateObject,
    streamText,
    embed,
    generateImage,
    synthesizeSpeech,
    transcribeAudio,
    resolveSlotToPresetId,
    getSlotParameterOverrides,
  };

  // ── Internal helpers ─────────────────────────────────────────────

  /** Merge abort signal from gateway options into provider config. */
  function configWithSignal(
    config: ProviderConfig,
    options?: GatewayOptions
  ): ProviderConfig {
    return options?.signal ? { ...config, signal: options.signal } : config;
  }

  async function runWithFallback<TResult>(
    input: { presetId?: string },
    mode: "text" | "object",
    options: GatewayOptions | undefined,
    execute: (
      target: ResolvedTarget,
      resolved: ProviderResolution
    ) => Promise<TResult>,
    resolveUsage: (result: TResult) => UsageSummary | null
  ): Promise<TResult> {
    const targets = deps.presetRegistry.resolveTextTargetChain(input);
    let lastError: AiProviderError | null = null;

    for (const [index, target] of targets.entries()) {
      const provider = targetProvider(target);
      let resolved = deps.providerRegistry.resolve(
        target.preset ?? target.profile,
        { mode }
      );
      if (options?.apiKeys) {
        resolved = deps.providerRegistry.withApiKeys(
          resolved,
          options.apiKeys,
          provider
        );
      }

      const startTime = Date.now();

      try {
        await notifyStart(resolved.hooks, provider, resolved.protocol, mode, targetModel(target), options?.traceId);
        const result = await execute(target, resolved);
        await notifySuccess(resolved.hooks, provider, resolved.protocol, mode, targetModel(target), resolveUsage(result), Date.now() - startTime, options?.traceId);
        return result;
      } catch (error) {
        await notifyError(resolved.hooks, provider, resolved.protocol, mode, targetModel(target), error, Date.now() - startTime, options?.traceId);
        const normalized = normalizeError(error, provider);
        lastError = normalized;

        if (index === targets.length - 1 || !shouldFallback(normalized)) {
          throw normalized;
        }
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
      resolved: ProviderResolution
    ) => Promise<TResult>
  ): Promise<TResult> {
    const target = deps.presetRegistry.resolveTextTarget({
      presetId,
    });
    let resolved = deps.providerRegistry.resolve(
      target.preset ?? target.profile,
      { mode }
    );
    if (options?.apiKeys) {
      resolved = deps.providerRegistry.withApiKeys(
        resolved,
        options.apiKeys,
        targetProvider(target)
      );
    }

    return runSingle(target, mode, resolved, options, () =>
      execute(target, resolved)
    );
  }

  async function runSingle<TResult>(
    target: ResolvedTarget,
    mode: OperationMode,
    resolved: ProviderResolution,
    options: GatewayOptions | undefined,
    execute: () => Promise<TResult>
  ): Promise<TResult> {
    const provider = targetProvider(target);
    const model = targetModel(target);
    const startTime = Date.now();

    try {
      await notifyStart(resolved.hooks, provider, resolved.protocol, mode, model, options?.traceId);
      const result = await execute();
      await notifySuccess(resolved.hooks, provider, resolved.protocol, mode, model, null, Date.now() - startTime, options?.traceId);
      return result;
    } catch (error) {
      await notifyError(resolved.hooks, provider, resolved.protocol, mode, model, error, Date.now() - startTime, options?.traceId);
      throw normalizeError(error, provider);
    }
  }
}

// ── Shared utilities ───────────────────────────────────────────────

function targetProvider(t: ResolvedTarget): string {
  return t.preset?.provider ?? t.profile.provider;
}

function targetModel(t: ResolvedTarget): string {
  return t.preset?.model ?? t.profile.model;
}

function shouldFallback(error: AiProviderError): boolean {
  return (
    error.code === "RATE_LIMITED" ||
    error.code === "PROVIDER_ERROR" ||
    error.code === "SCHEMA_VALIDATION_FAILED"
  );
}

function normalizeError(error: unknown, provider: string): AiProviderError {
  if (error instanceof AiProviderError) return error;

  if (error instanceof Error) {
    try {
      const parsed = JSON.parse(error.message) as {
        code?: string;
        provider?: string;
        retriable?: boolean;
        statusCode?: number;
      };
      if (parsed.code && parsed.provider) {
        return new AiProviderError({
          code: parsed.code as AiProviderError["code"],
          message: error.message,
          provider: parsed.provider,
          retriable: Boolean(parsed.retriable),
          statusCode: parsed.statusCode,
        });
      }
    } catch {
      // Not a JSON error message
    }
  }

  return new AiProviderError({
    code: "PROVIDER_ERROR",
    message: error instanceof Error ? error.message : "Unknown provider error.",
    provider,
    retriable: false,
    cause: error,
  });
}

async function notifyStart(
  hooks: ProviderLifecycleHook[],
  provider: string,
  protocol: ProviderProtocol,
  mode: OperationMode,
  model: string,
  traceId?: string
) {
  for (const hook of hooks) {
    try {
      await hook.onRequestStart?.({ provider, protocol, mode, model, traceId });
    } catch (err) {
      console.warn(`[ai-provider] Hook onRequestStart failed:`, err instanceof Error ? err.message : err);
    }
  }
}

async function notifySuccess(
  hooks: ProviderLifecycleHook[],
  provider: string,
  protocol: ProviderProtocol,
  mode: OperationMode,
  model: string,
  usage: UsageSummary | null,
  durationMs: number,
  traceId?: string
) {
  for (const hook of hooks) {
    try {
      await hook.onRequestSuccess?.({
        provider,
        protocol,
        mode,
        model,
        usage,
        durationMs,
        traceId,
      });
    } catch (err) {
      console.warn(`[ai-provider] Hook onRequestSuccess failed:`, err instanceof Error ? err.message : err);
    }
  }
}

async function notifyError(
  hooks: ProviderLifecycleHook[],
  provider: string,
  protocol: ProviderProtocol,
  mode: OperationMode,
  model: string,
  error: unknown,
  durationMs: number,
  traceId?: string
) {
  for (const hook of hooks) {
    try {
      await hook.onRequestError?.({
        provider,
        protocol,
        mode,
        model,
        error,
        durationMs,
        traceId,
      });
    } catch (err) {
      console.warn(`[ai-provider] Hook onRequestError failed:`, err instanceof Error ? err.message : err);
    }
  }
}
