// Types
export type {
  ProviderProtocol,
  OperationMode,
  ModelTier,
  ProviderConfig,
  ProviderDefaults,
  ModelProfile,
  PresetConfig,
  TextGenerationParams,
  TextMessage,
  UsageSummary,
  TextGenerationResult,
  ObjectGenerationParams,
  ObjectGenerationResult,
  StreamEvent,
  EmbeddingParams,
  EmbeddingResult,
  ImageGenerationParams,
  GeneratedImage,
  ImageGenerationResult,
  SpeechSynthesisParams,
  SpeechSynthesisResult,
  TranscriptionParams,
  TranscriptionResult,
  ModelRequestContext,
  ResolvedTarget,
  ProviderLifecycleHook,
  AiConfig,
  ModelSlotId,
  ModelSlotConfig,
  ModelParameterOverrides,
  ModelSlotMap,
} from "./types.js";

// Errors
export { AiProviderError, type AiProviderErrorCode } from "./errors.js";

// Config
export { loadAiConfig, parseAiConfig } from "./config/loader.js";
export { aiConfigSchema, presetConfigSchema, modelProfileSchema } from "./config/schema.js";

// Adapters
export type { ModelProviderAdapter } from "./adapters/adapter.js";
export { createOpenAiChatAdapter } from "./adapters/openai-chat.js";
export { createOpenAiResponsesAdapter } from "./adapters/openai-responses.js";
export { createAnthropicMessagesAdapter } from "./adapters/anthropic-messages.js";

// Registries
export { createProviderRegistry } from "./provider-registry.js";
export { createPresetRegistry } from "./preset-registry.js";
export { createSlotRegistry, type SlotRegistry } from "./slot-registry.js";

// Gateway
export { createGateway, type GatewayOptions } from "./gateway.js";

// Trace
export type { TraceContext } from "./trace/context.js";
export { createLangfuseHook } from "./trace/langfuse.js";
