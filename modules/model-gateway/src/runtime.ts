import type { z } from "zod";

import { ModelGatewayError } from "./model-gateway-error.js";
import type { ModelProfile, PresetMetadata } from "./model-profile-registry.js";
import type {
  EmbeddingResult,
  ImageGenerationParams,
  ImageGenerationResult,
  ObjectGenerationParams,
  ProviderLifecycleHook,
  SpeechSynthesisParams,
  SpeechSynthesisResult,
  StreamEvent,
  TextGenerationParams,
  TranscriptionParams,
  TranscriptionResult
} from "./provider-registry.js";

type TextMessage = {
  role: string;
  content: string;
};

type ResolvedTextTarget = {
  profile: ModelProfile;
  preset: PresetMetadata | null;
};

export function createModelGateway(dependencies: {
  providerRegistry: {
    resolve(
      target: Pick<PresetMetadata, "provider" | "baseUrl" | "protocol"> |
        Pick<ModelProfile, "provider">,
      options?: { mode: "text" | "object" | "stream" | "embed" | "image" | "speech" | "transcription" }
    ): {
      adapter: {
        generateText: (
          config: { baseUrl?: string; apiKey?: string; headers?: Record<string, string> },
          params: TextGenerationParams,
          context: { profile: ModelProfile; preset: PresetMetadata | null; mode: "text" | "object" | "stream" | "embed" | "image" | "speech" | "transcription" }
        ) => Promise<{ text: string; finishReason: string; usage: { inputTokens: number; outputTokens: number } }>;
        generateObject: <TObject>(
          config: { baseUrl?: string; apiKey?: string; headers?: Record<string, string> },
          params: ObjectGenerationParams<TObject>,
          context: { profile: ModelProfile; preset: PresetMetadata | null; mode: "text" | "object" | "stream" | "embed" | "image" | "speech" | "transcription" }
        ) => Promise<{ object: TObject; finishReason: string; usage: { inputTokens: number; outputTokens: number } }>;
        streamText: (
          config: { baseUrl?: string; apiKey?: string; headers?: Record<string, string> },
          params: TextGenerationParams,
          context: { profile: ModelProfile; preset: PresetMetadata | null; mode: "text" | "object" | "stream" | "embed" | "image" | "speech" | "transcription" }
        ) => AsyncIterable<StreamEvent>;
        embed: (
          config: { baseUrl?: string; apiKey?: string; headers?: Record<string, string> },
          params: { model: string; values: string[]; providerRequestMetadata?: Record<string, unknown> },
          context: { profile: ModelProfile; preset: PresetMetadata | null; mode: "text" | "object" | "stream" | "embed" | "image" | "speech" | "transcription" }
        ) => Promise<EmbeddingResult>;
        generateImage: (
          config: { baseUrl?: string; apiKey?: string; headers?: Record<string, string> },
          params: ImageGenerationParams,
          context: { profile: ModelProfile; preset: PresetMetadata | null; mode: "text" | "object" | "stream" | "embed" | "image" | "speech" | "transcription" }
        ) => Promise<ImageGenerationResult>;
        synthesizeSpeech: (
          config: { baseUrl?: string; apiKey?: string; headers?: Record<string, string> },
          params: SpeechSynthesisParams,
          context: { profile: ModelProfile; preset: PresetMetadata | null; mode: "text" | "object" | "stream" | "embed" | "image" | "speech" | "transcription" }
        ) => Promise<SpeechSynthesisResult>;
        transcribeAudio: (
          config: { baseUrl?: string; apiKey?: string; headers?: Record<string, string> },
          params: TranscriptionParams,
          context: { profile: ModelProfile; preset: PresetMetadata | null; mode: "text" | "object" | "stream" | "embed" | "image" | "speech" | "transcription" }
        ) => Promise<TranscriptionResult>;
      };
      config: {
        baseUrl?: string;
        apiKey?: string;
        headers?: Record<string, string>;
      };
      protocol: string;
      hooks: ProviderLifecycleHook[];
    };
  };
  profileRegistry: {
    resolveTextTarget(input: {
      presetId?: string;
      projectOverride?: {
        preset?: Partial<PresetMetadata>;
        profile?: Partial<ModelProfile> & Pick<ModelProfile, "id">;
      };
      sessionOverride?: {
        preset?: Partial<PresetMetadata>;
        profile?: Partial<ModelProfile> & Pick<ModelProfile, "id">;
      };
    }): { profile: ModelProfile; preset: PresetMetadata | null };
    resolveEmbeddingTarget(input: { presetId?: string }): { profile: ModelProfile; preset: null };
  };
}) {
  async function generateText(input: {
    presetId?: string;
    messages: TextMessage[];
    providerRequestMetadata?: Record<string, unknown>;
  }) {
    return runTextOperationWithFallback(
      {
        presetId: input.presetId
      },
      "text",
      async (target, resolved) =>
        resolved.adapter.generateText(
          resolved.config,
          {
            model: resolveTargetModel(target),
            messages: input.messages,
            providerRequestMetadata: input.providerRequestMetadata
          },
          {
            profile: target.profile,
            preset: target.preset,
            mode: "text"
          }
        ),
      (result) => result.usage
    );
  }

  async function generateObject<TObject>(input: {
    presetId?: string;
    schema: z.ZodType<TObject>;
    messages: TextMessage[];
    providerRequestMetadata?: Record<string, unknown>;
  }) {
    return runTextOperationWithFallback(
      {
        presetId: input.presetId
      },
      "object",
      async (target, resolved) => {
        const result = await resolved.adapter.generateObject(
          resolved.config,
          {
            model: resolveTargetModel(target),
            schema: input.schema,
            messages: input.messages,
            providerRequestMetadata: input.providerRequestMetadata
          },
          {
            profile: target.profile,
            preset: target.preset,
            mode: "object"
          }
        );

        return result as {
          object: TObject;
          finishReason: string;
          usage: {
            inputTokens: number;
            outputTokens: number;
          };
        };
      },
      (result) => result.usage
    );
  }

  async function* streamText(input: {
    presetId?: string;
    messages: TextMessage[];
    providerRequestMetadata?: Record<string, unknown>;
  }) {
    const targets = resolveTextTargets({
      presetId: input.presetId
    });
    let lastError: ModelGatewayError | null = null;

    for (const [index, target] of targets.entries()) {
      const resolved = dependencies.providerRegistry.resolve(target.preset ?? target.profile, {
        mode: "stream"
      });
      const provider = resolveTargetProvider(target);
      const model = resolveTargetModel(target);
      let emittedDelta = false;

      try {
        await notifyRequestStart(resolved.hooks, {
          provider,
          protocol: resolved.protocol,
          mode: "stream",
          model
        });
        let finalUsage: { inputTokens: number; outputTokens: number } | null = null;
        for await (const event of resolved.adapter.streamText(
          resolved.config,
          {
            model,
            messages: input.messages,
            providerRequestMetadata: input.providerRequestMetadata
          },
          {
            profile: target.profile,
            preset: target.preset,
            mode: "stream"
          }
        )) {
          if (event.type === "text-delta" && event.textDelta.length > 0) {
            emittedDelta = true;
          }
          if (event.type === "done") {
            finalUsage = event.usage;
          }
          yield event;
        }
        await notifyRequestSuccess(resolved.hooks, {
          provider,
          protocol: resolved.protocol,
          mode: "stream",
          model,
          usage: finalUsage
        });
        return;
      } catch (error) {
        await notifyRequestError(resolved.hooks, {
          provider,
          protocol: resolved.protocol,
          mode: "stream",
          model,
          error
        });
        const normalized = normalizeGatewayError(error, provider);
        lastError = normalized;

        if (emittedDelta || index === targets.length - 1 || !shouldAttemptFallback(normalized)) {
          throw normalized;
        }
      }
    }

    if (lastError) {
      throw lastError;
    }
  }

  async function embed(input: {
    presetId?: string;
    values: string[];
    providerRequestMetadata?: Record<string, unknown>;
  }) {
    const target = dependencies.profileRegistry.resolveEmbeddingTarget({
      presetId: input.presetId
    });
    const fallbackTextTarget = dependencies.profileRegistry.resolveTextTarget({
      presetId: input.presetId
    });
    const resolved = dependencies.providerRegistry.resolve(fallbackTextTarget.preset ?? target.profile, {
      mode: "embed"
    });

    try {
      await notifyRequestStart(resolved.hooks, {
        provider: target.profile.provider,
        protocol: resolved.protocol,
        mode: "embed",
        model: target.profile.model
      });
      return await resolved.adapter.embed(
        resolved.config,
        {
          model: target.profile.model,
          values: input.values,
          providerRequestMetadata: input.providerRequestMetadata
        },
        {
          profile: target.profile,
          preset: target.preset,
          mode: "embed"
        }
      ).then(async (result) => {
        await notifyRequestSuccess(resolved.hooks, {
          provider: target.profile.provider,
          protocol: resolved.protocol,
          mode: "embed",
          model: target.profile.model,
          usage: result.usage
        });
        return result;
      });
    } catch (error) {
      await notifyRequestError(resolved.hooks, {
        provider: target.profile.provider,
        protocol: resolved.protocol,
        mode: "embed",
        model: target.profile.model,
        error
      });
      throw normalizeGatewayError(error, target.profile.provider);
    }
  }

  async function generateImage(input: {
    presetId?: string;
    prompt: string;
    providerRequestMetadata?: Record<string, unknown>;
  }) {
    return runSingleTargetOperation({
      presetId: input.presetId
    }, "image", async (target, resolved) =>
      resolved.adapter.generateImage(
        resolved.config,
        {
          model: resolveTargetModel(target),
          prompt: input.prompt,
          providerRequestMetadata: input.providerRequestMetadata
        },
        {
          profile: target.profile,
          preset: target.preset,
          mode: "image"
        }
      )
    );
  }

  async function synthesizeSpeech(input: {
    presetId?: string;
    text: string;
    voice?: string;
    format?: string;
    providerRequestMetadata?: Record<string, unknown>;
  }) {
    return runSingleTargetOperation({
      presetId: input.presetId
    }, "speech", async (target, resolved) =>
      resolved.adapter.synthesizeSpeech(
        resolved.config,
        {
          model: resolveTargetModel(target),
          text: input.text,
          ...(input.voice ? { voice: input.voice } : {}),
          ...(input.format ? { format: input.format } : {}),
          providerRequestMetadata: input.providerRequestMetadata
        },
        {
          profile: target.profile,
          preset: target.preset,
          mode: "speech"
        }
      )
    );
  }

  async function transcribeAudio(input: {
    presetId?: string;
    audio: {
      data: Uint8Array;
      mimeType: string;
      fileName?: string;
    };
    providerRequestMetadata?: Record<string, unknown>;
  }) {
    return runSingleTargetOperation({
      presetId: input.presetId
    }, "transcription", async (target, resolved) =>
      resolved.adapter.transcribeAudio(
        resolved.config,
        {
          model: resolveTargetModel(target),
          audio: input.audio,
          providerRequestMetadata: input.providerRequestMetadata
        },
        {
          profile: target.profile,
          preset: target.preset,
          mode: "transcription"
        }
      )
    );
  }

  return {
    generateText,
    generateObject,
    streamText,
    embed,
    generateImage,
    synthesizeSpeech,
    transcribeAudio
  };

  async function runTextOperationWithFallback<TResult>(
    input: {
      presetId?: string;
    },
    mode: "text" | "object",
    execute: (
      target: ResolvedTextTarget,
      resolved: ReturnType<typeof dependencies.providerRegistry.resolve>
    ) => Promise<TResult>,
    resolveUsage: (result: TResult) => { inputTokens: number; outputTokens: number } | null
  ): Promise<TResult> {
    const targets = resolveTextTargets(input);
    let lastError: ModelGatewayError | null = null;

    for (const [index, target] of targets.entries()) {
      const resolved = dependencies.providerRegistry.resolve(target.preset ?? target.profile, {
        mode
      });
      const provider = resolveTargetProvider(target);
      const model = resolveTargetModel(target);

      try {
        await notifyRequestStart(resolved.hooks, {
          provider,
          protocol: resolved.protocol,
          mode,
          model
        });
        const result = await execute(target, resolved);
        await notifyRequestSuccess(resolved.hooks, {
          provider,
          protocol: resolved.protocol,
          mode,
          model,
          usage: resolveUsage(result)
        });
        return result;
      } catch (error) {
        await notifyRequestError(resolved.hooks, {
          provider,
          protocol: resolved.protocol,
          mode,
          model,
          error
        });
        const normalized = normalizeGatewayError(error, provider);
        lastError = normalized;

        if (index === targets.length - 1 || !shouldAttemptFallback(normalized)) {
          throw normalized;
        }
      }
    }

    throw lastError ?? new ModelGatewayError({
      code: "PROVIDER_ERROR",
      message: "No model target could be resolved.",
      provider: "unknown",
      retriable: false
    });
  }

  function resolveTextTargets(input: {
    presetId?: string;
  }): ResolvedTextTarget[] {
    const primaryTarget = dependencies.profileRegistry.resolveTextTarget({
      presetId: input.presetId
    });
    const targets: ResolvedTextTarget[] = [primaryTarget];
    const visitedPresetIds = new Set<string>();

    if (primaryTarget.preset?.id) {
      visitedPresetIds.add(primaryTarget.preset.id);
    }

    collectFallbackTargets(primaryTarget.preset?.fallbackPresetIds ?? []);
    return targets;

    function collectFallbackTargets(fallbackPresetIds: string[]) {
      for (const fallbackPresetId of fallbackPresetIds) {
        if (visitedPresetIds.has(fallbackPresetId)) {
          continue;
        }

        visitedPresetIds.add(fallbackPresetId);
        try {
          const fallbackTarget = dependencies.profileRegistry.resolveTextTarget({
            presetId: fallbackPresetId
          });
          targets.push(fallbackTarget);
          collectFallbackTargets(fallbackTarget.preset?.fallbackPresetIds ?? []);
        } catch {
          continue;
        }
      }
    }
  }

  async function runSingleTargetOperation<TResult>(
    input: {
      presetId?: string;
    },
    mode: "image" | "speech" | "transcription",
    execute: (
      target: ResolvedTextTarget,
      resolved: ReturnType<typeof dependencies.providerRegistry.resolve>
    ) => Promise<TResult>
  ): Promise<TResult> {
    const target = dependencies.profileRegistry.resolveTextTarget({
      presetId: input.presetId
    });
    const resolved = dependencies.providerRegistry.resolve(target.preset ?? target.profile, {
      mode
    });
    const provider = resolveTargetProvider(target);
    const model = resolveTargetModel(target);

    try {
      await notifyRequestStart(resolved.hooks, {
        provider,
        protocol: resolved.protocol,
        mode,
        model
      });
      const result = await execute(target, resolved);
      await notifyRequestSuccess(resolved.hooks, {
        provider,
        protocol: resolved.protocol,
        mode,
        model,
        usage: null
      });
      return result;
    } catch (error) {
      await notifyRequestError(resolved.hooks, {
        provider,
        protocol: resolved.protocol,
        mode,
        model,
        error
      });
      throw normalizeGatewayError(error, provider);
    }
  }
}

function resolveTargetProvider(target: ResolvedTextTarget): string {
  return target.preset?.provider ?? target.profile.provider;
}

function resolveTargetModel(target: ResolvedTextTarget): string {
  return target.preset?.model ?? target.profile.model;
}

function shouldAttemptFallback(error: ModelGatewayError): boolean {
  return (
    error.code === "RATE_LIMITED" ||
    error.code === "PROVIDER_ERROR" ||
    error.code === "SCHEMA_VALIDATION_FAILED"
  );
}

function normalizeGatewayError(error: unknown, provider: string): ModelGatewayError {
  if (error instanceof ModelGatewayError) {
    return error;
  }

  if (error instanceof Error) {
    try {
      const parsed = JSON.parse(error.message) as {
        code?: string;
        provider?: string;
        retriable?: boolean;
        statusCode?: number;
      };

      if (parsed.code && parsed.provider) {
        return new ModelGatewayError({
          code: parsed.code as "RATE_LIMITED" | "SCHEMA_VALIDATION_FAILED" | "PROVIDER_ERROR",
          message: error.message,
          provider: parsed.provider,
          retriable: Boolean(parsed.retriable),
          statusCode: parsed.statusCode
        });
      }
    } catch {
      // fall through to provider error wrapping
    }
  }

  return new ModelGatewayError({
    code: "PROVIDER_ERROR",
    message: error instanceof Error ? error.message : "Unknown provider failure.",
    provider,
    retriable: false,
    cause: error
  });
}

async function notifyRequestStart(
  hooks: ProviderLifecycleHook[],
  event: {
    provider: string;
    protocol: string;
    mode: "text" | "object" | "stream" | "embed" | "image" | "speech" | "transcription";
    model: string;
  }
) {
  for (const hook of hooks) {
    await hook.onRequestStart?.(event as any);
  }
}

async function notifyRequestSuccess(
  hooks: ProviderLifecycleHook[],
  event: {
    provider: string;
    protocol: string;
    mode: "text" | "object" | "stream" | "embed" | "image" | "speech" | "transcription";
    model: string;
    usage: { inputTokens: number; outputTokens: number } | null;
  }
) {
  for (const hook of hooks) {
    await hook.onRequestSuccess?.(event as any);
  }
}

async function notifyRequestError(
  hooks: ProviderLifecycleHook[],
  event: {
    provider: string;
    protocol: string;
    mode: "text" | "object" | "stream" | "embed" | "image" | "speech" | "transcription";
    model: string;
    error: unknown;
  }
) {
  for (const hook of hooks) {
    await hook.onRequestError?.(event as any);
  }
}
