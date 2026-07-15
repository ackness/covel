// Types
export { PROVIDER_PROTOCOLS } from "./types.js";
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
export { BUNDLED_MODEL_DB_PATH } from "./bundled-resources.js";

// Config
export { loadLlmConfig, parseLlmConfig } from "./config/llm-loader.js";
export {
  llmConfigSchema,
  type LlmConfig,
  type SlotDefinition,
} from "./config/llm-schema.js";

// Adapters
export type { ModelProviderAdapter } from "./adapters/adapter.js";
export { createOpenAiChatAdapter } from "./adapters/openai-chat.js";
export { createOpenAiResponsesAdapter } from "./adapters/openai-responses.js";
export { createAnthropicMessagesAdapter } from "./adapters/anthropic-messages.js";

// Registries
export { createProviderRegistry } from "./provider-registry.js";
export { createPresetRegistry } from "./preset-registry.js";
export { createSlotRegistry, type SlotRegistry } from "./slot-registry.js";

// Protocol registry (protocol-scoped adapter / cache / capability lookup)
export {
  getProtocolDefinition,
  BASE_CAPABILITY_DEFAULTS,
  type ProtocolDefinition,
} from "./protocol-registry.js";

// Gateway
export { createGateway, type GatewayOptions } from "./gateway.js";

// Image generation (pluggable wires — plugins register custom formats)
export {
  registerImageWire,
  getImageWire,
  DEFAULT_IMAGE_WIRE,
} from "./image/wire-registry.js";
export type {
  ImageGenerationParams,
  ImageGenerationResult,
  GeneratedImageSource,
  ImageWire,
} from "./image/types.js";

// Speech synthesis / transcription (pluggable wires, same contract as image)
export {
  registerSpeechWire,
  getSpeechWire,
  DEFAULT_SPEECH_WIRE,
  registerTranscriptionWire,
  getTranscriptionWire,
  DEFAULT_TRANSCRIPTION_WIRE,
} from "./speech/wire-registry.js";
export type { SpeechWire, TranscriptionWire } from "./speech/types.js";

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
  type WireModuleShape,
} from "./plugin-utils.js";

// Capability
export {
  resolveCapability,
  setModelDatabase,
  createModelDatabase,
  fetchLiteLlmModels,
  type KnownModelEntry,
  type ManualCapabilityOverride,
  type ModelDatabase,
  type ModelDbEntry,
  type ModelDbFile,
  type ModelDbPersistence,
} from "./capability/index.js";

// Trace
export { createLangfuseHook } from "./trace/langfuse.js";
