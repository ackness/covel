// Types
export type {
  ProviderProtocol,
  OperationMode,
  InputModality,
  OutputModality,
  ModelFeature,
  ModelCapability,
  ModelPricing,
  ModelTier,
  ProviderConfig,
  ProviderDefaults,
  ModelProfile,
  PresetConfig,
  ToolDefinition,
  ToolCallPart,
  TextPart,
  ImagePart,
  TextMessageContentPart,
  TextMessageContent,
  TextGenerationParams,
  TextMessage,
  UsageSummary,
  TextGenerationResult,
  ObjectGenerationParams,
  ObjectGenerationResult,
  StreamEvent,
  EmbeddingParams,
  EmbeddingResult,
  SpeechSynthesisParams,
  SpeechSynthesisResult,
  TranscriptionParams,
  TranscriptionResult,
  ModelRequestContext,
  ResolvedTarget,
  ResolvedSlotConfig,
  ProviderLifecycleHook,
  AiConfig,
  ModelSlotConfig,
  ModelParameterOverrides,
  ModelSlotMap,
  CacheStrategy,
  SlotOverridesInput,
  CustomPresetInput,
} from "./types.js";

// Errors
export { AiProviderError, type AiProviderErrorCode } from "./errors.js";

// Bundled resources
export {
  BUNDLED_DEFAULT_PRESET_PATH,
  BUNDLED_MODEL_DB_PATH,
} from "./bundled-resources.js";

// Config
export { loadAiConfig, parseAiConfig } from "./config/loader.js";
export { aiConfigSchema, presetConfigSchema, modelProfileSchema } from "./config/schema.js";
export { loadLlmConfig, parseLlmConfig } from "./config/llm-loader.js";
export { llmConfigSchema, type LlmConfig, type SlotDefinition } from "./config/llm-schema.js";

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

// Slot overlay (per-request preset/provider injection)
export {
  applySlotOverlay,
  resolveSlotOverride,
  type OverlayDeps,
} from "./slot-overlay.js";

// Plugin utilities (exposed via runtime → ctx.utils)
export {
  validateBaseUrlForPlugin,
  fetchWithRetry,
  type BaseUrlValidationResult,
  type FetchWithRetryOptions,
} from "./plugin-utils.js";

// Capability
export {
  resolveCapability,
  lookupKnownModel,
  setModelDatabase,
  getModelDatabase,
  createModelDatabase,
  fetchLiteLlmModels,
  KNOWN_MODELS,
  MODEL_ALIASES,
  type KnownModelEntry,
  type ManualCapabilityOverride,
  type ModelDatabase,
  type ModelDbEntry,
  type ModelDbFile,
  type ModelDbPersistence,
} from "./capability/index.js";

// Trace
export type { TraceContext } from "./trace/context.js";
export { createLangfuseHook } from "./trace/langfuse.js";

// Tokenizer
export {
  estimateTokens,
  approximateTokenCounter,
  setTokenCounter,
  resetTokenCounter,
  TOKEN_SAFETY_MULTIPLIERS,
  type ProviderFamily,
  type EstimateTokensOptions,
  type TokenCounter,
} from "./tokenizer.js";
