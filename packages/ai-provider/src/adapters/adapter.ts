import type {
  EmbeddingParams,
  EmbeddingResult,
  ModelRequestContext,
  ObjectGenerationParams,
  ObjectGenerationResult,
  ProviderConfig,
  StreamEvent,
  TextGenerationParams,
  TextGenerationResult,
} from "../types.js";

/**
 * Adapter interface for a single model provider protocol.
 * Each protocol (OpenAI Chat, Anthropic Messages, etc.) implements this.
 */
export interface ModelProviderAdapter {
  generateText(
    config: ProviderConfig,
    params: TextGenerationParams,
    context?: ModelRequestContext,
  ): Promise<TextGenerationResult>;

  generateObject<TObject>(
    config: ProviderConfig,
    params: ObjectGenerationParams<TObject>,
    context?: ModelRequestContext,
  ): Promise<ObjectGenerationResult<TObject>>;

  streamText(
    config: ProviderConfig,
    params: TextGenerationParams,
    context?: ModelRequestContext,
  ): AsyncIterable<StreamEvent>;

  embed(
    config: ProviderConfig,
    params: EmbeddingParams,
    context?: ModelRequestContext,
  ): Promise<EmbeddingResult>;
}
