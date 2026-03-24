import type { z } from "zod";

import { ModelGatewayError } from "./model-gateway-error.js";
import type { ModelProfile, PresetMetadata } from "./model-profile-registry.js";
import type {
  EmbeddingResult,
  ObjectGenerationParams,
  StreamEvent,
  TextGenerationParams
} from "./provider-registry.js";

type TextMessage = {
  role: string;
  content: string;
};

export function createModelGateway(dependencies: {
  providerRegistry: {
    resolve(target: Pick<PresetMetadata, "provider" | "baseUrl"> | Pick<ModelProfile, "provider">): {
      adapter: {
        generateText: (
          config: { baseUrl?: string; apiKey?: string; headers?: Record<string, string> },
          params: TextGenerationParams,
          context: { profile: ModelProfile; preset: PresetMetadata | null; mode: "text" | "object" | "stream" | "embed" }
        ) => Promise<{ text: string; finishReason: string; usage: { inputTokens: number; outputTokens: number } }>;
        generateObject: <TObject>(
          config: { baseUrl?: string; apiKey?: string; headers?: Record<string, string> },
          params: ObjectGenerationParams<TObject>,
          context: { profile: ModelProfile; preset: PresetMetadata | null; mode: "text" | "object" | "stream" | "embed" }
        ) => Promise<{ object: TObject; finishReason: string; usage: { inputTokens: number; outputTokens: number } }>;
        streamText: (
          config: { baseUrl?: string; apiKey?: string; headers?: Record<string, string> },
          params: TextGenerationParams,
          context: { profile: ModelProfile; preset: PresetMetadata | null; mode: "text" | "object" | "stream" | "embed" }
        ) => AsyncIterable<StreamEvent>;
        embed: (
          config: { baseUrl?: string; apiKey?: string; headers?: Record<string, string> },
          params: { model: string; values: string[]; providerRequestMetadata?: Record<string, unknown> },
          context: { profile: ModelProfile; preset: PresetMetadata | null; mode: "text" | "object" | "stream" | "embed" }
        ) => Promise<EmbeddingResult>;
      };
      config: {
        baseUrl?: string;
        apiKey?: string;
        headers?: Record<string, string>;
      };
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
    const target = dependencies.profileRegistry.resolveTextTarget({
      presetId: input.presetId
    });
    const resolved = dependencies.providerRegistry.resolve(target.preset ?? target.profile);

    try {
      return await resolved.adapter.generateText(
        resolved.config,
        {
          model: target.preset?.model ?? target.profile.model,
          messages: input.messages,
          providerRequestMetadata: input.providerRequestMetadata
        },
        {
          profile: target.profile,
          preset: target.preset,
          mode: "text"
        }
      );
    } catch (error) {
      throw normalizeGatewayError(error, target.profile.provider);
    }
  }

  async function generateObject<TObject>(input: {
    presetId?: string;
    schema: z.ZodType<TObject>;
    messages: TextMessage[];
    providerRequestMetadata?: Record<string, unknown>;
  }) {
    const target = dependencies.profileRegistry.resolveTextTarget({
      presetId: input.presetId
    });
    const resolved = dependencies.providerRegistry.resolve(target.preset ?? target.profile);

    try {
      return await resolved.adapter.generateObject(
        resolved.config,
        {
          model: target.preset?.model ?? target.profile.model,
          schema: input.schema,
          messages: input.messages,
          providerRequestMetadata: input.providerRequestMetadata
        },
        {
          profile: target.profile,
          preset: target.preset,
          mode: "object"
        }
      ) as {
        object: TObject;
        finishReason: string;
        usage: {
          inputTokens: number;
          outputTokens: number;
        };
      };
    } catch (error) {
      throw normalizeGatewayError(error, target.profile.provider);
    }
  }

  async function* streamText(input: {
    presetId?: string;
    messages: TextMessage[];
    providerRequestMetadata?: Record<string, unknown>;
  }) {
    const target = dependencies.profileRegistry.resolveTextTarget({
      presetId: input.presetId
    });
    const resolved = dependencies.providerRegistry.resolve(target.preset ?? target.profile);

    try {
      for await (const event of resolved.adapter.streamText(
        resolved.config,
        {
          model: target.preset?.model ?? target.profile.model,
          messages: input.messages,
          providerRequestMetadata: input.providerRequestMetadata
        },
        {
          profile: target.profile,
          preset: target.preset,
          mode: "stream"
        }
      )) {
        yield event;
      }
    } catch (error) {
      throw normalizeGatewayError(error, target.profile.provider);
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
    const resolved = dependencies.providerRegistry.resolve(fallbackTextTarget.preset ?? target.profile);

    try {
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
      );
    } catch (error) {
      throw normalizeGatewayError(error, target.profile.provider);
    }
  }

  return {
    generateText,
    generateObject,
    streamText,
    embed
  };
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
