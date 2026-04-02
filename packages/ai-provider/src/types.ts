import type { ZodType } from "zod";

// ── Provider Protocol ──────────────────────────────────────────────

export type ProviderProtocol =
  | "openai-chat-v1"
  | "openai-responses-v1"
  | "anthropic-messages-v1";

// ── Operation Mode ─────────────────────────────────────────────────

export type OperationMode =
  | "text"
  | "object"
  | "stream"
  | "embed"
  | "image"
  | "speech"
  | "transcription";

// ── Model Capability ──────────────────────────────────────────────

/** What a model can accept as input. */
export type InputModality = "text" | "image" | "audio" | "video" | "file";

/** What a model can produce as output. */
export type OutputModality = "text" | "image" | "audio" | "embedding";

/** Feature flags for model capabilities beyond basic I/O. */
export type ModelFeature =
  | "function_calling"
  | "structured_output"
  | "streaming"
  | "reasoning"
  | "vision"
  | "prompt_caching"
  | "web_search"
  | "computer_use";

/**
 * Pricing information per million tokens (USD).
 *
 * Separate fields for text vs multimodal I/O to reflect real provider pricing.
 */
export interface ModelPricing {
  /** Cost per 1M text input tokens (USD) */
  inputPerMToken?: number;
  /** Cost per 1M text output tokens (USD) */
  outputPerMToken?: number;
  /** Cost per 1M image input tokens (USD) — vision models */
  imageInputPerMToken?: number;
  /** Cost per 1M audio input tokens (USD) — audio understanding */
  audioInputPerMToken?: number;
  /** Cost per 1M audio output tokens (USD) — speech synthesis */
  audioOutputPerMToken?: number;
  /** Cost per generated image (USD) — image generation models */
  perImage?: number;
}

/**
 * Describes a model's multimodal capabilities.
 *
 * Follows OpenRouter's directional modality taxonomy:
 * - `input` = what the model ACCEPTS (e.g. vision model accepts image)
 * - `output` = what the model PRODUCES (e.g. image gen model produces image)
 *
 * "image" in input ≠ "image" in output. Same for audio/video.
 *
 * Data sources (priority order):
 * 1. Manual override in llm.toml
 * 2. Known model database (curated from LiteLLM/OpenRouter)
 * 3. Protocol-based defaults
 */
export interface ModelCapability {
  /** Accepted input types (e.g. ["text", "image"] for vision model) */
  input: InputModality[];
  /** Produced output types (e.g. ["text"] for chat, ["image"] for image gen) */
  output: OutputModality[];
  /** Feature flags beyond basic I/O */
  features?: ModelFeature[];
  /** Maximum input context window (tokens) */
  contextWindow?: number;
  /** Maximum output tokens the model can produce */
  maxOutputTokens?: number;
  /** Pricing info (per million tokens, USD) */
  pricing?: ModelPricing;
}

// ── Model Tier ─────────────────────────────────────────────────────

export type ModelTier = "small" | "medium" | "large" | "embed-default";

// ── Provider Config ────────────────────────────────────────────────

export interface ProviderConfig {
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  /** Abort signal for request cancellation. */
  signal?: AbortSignal;
}

// ── Provider Defaults (from TOML [providers.*]) ────────────────────

export interface ProviderDefaults {
  baseUrl?: string;
  protocol?: ProviderProtocol;
  headers?: Record<string, string>;
}

// ── Model Profile ──────────────────────────────────────────────────

export interface ModelProfile {
  id: string;
  tier: ModelTier;
  provider: string;
  model: string;
  contextWindow: number;
  latencyClass: string;
  costClass: string;
  supportedModes: OperationMode[];
}

// ── Preset Config (from TOML [[presets]]) ──────────────────────────

export interface PresetConfig {
  id: string;
  name: string;
  provider: string;
  protocol?: ProviderProtocol;
  model: string;
  tier: Exclude<ModelTier, "embed-default">;
  baseUrl?: string;
  fallbackPresetIds?: string[];
  supportedModes: OperationMode[];
  enabled: boolean;
  isDefault?: boolean;
  scope?: string;
  defaultSlot?: ModelSlotId;
  providerRequestMetadata?: Record<string, unknown>;
  /** Multimodal capability descriptor. Auto-inferred or manually set. */
  capability?: ModelCapability;
}

// ── Tool Calling ──────────────────────────────────────────────────

/** OpenAI-compatible function tool definition. */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/** A tool call returned by the model. */
export interface ToolCallPart {
  id: string;
  name: string;
  arguments: string;
}

// ── Text Generation ────────────────────────────────────────────────

export interface TextGenerationParams {
  model: string;
  messages: TextMessage[];
  /** Tool definitions to pass to the model (OpenAI function calling format). */
  tools?: ToolDefinition[];
  providerRequestMetadata?: Record<string, unknown>;
}

export interface TextMessage {
  role: string;
  content: string | null;
  /** Prompt cache hint for providers that support it (e.g. Anthropic cache_control) */
  cacheControl?: { type: "ephemeral" };
  /** Tool calls made by assistant (present when role === "assistant" and model invoked tools). */
  toolCalls?: ToolCallPart[];
  /** Tool call ID this message responds to (present when role === "tool"). */
  toolCallId?: string;
}

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
}

export interface TextGenerationResult {
  text: string;
  finishReason: string;
  usage: UsageSummary;
  /** Tool calls requested by the model (present when finishReason involves tool use). */
  toolCalls?: ToolCallPart[];
}

// ── Object Generation ──────────────────────────────────────────────

export interface ObjectGenerationParams<TObject = unknown>
  extends TextGenerationParams {
  schema: ZodType<TObject>;
}

export interface ObjectGenerationResult<TObject = unknown> {
  object: TObject;
  finishReason: string;
  usage: UsageSummary;
}

// ── Streaming ──────────────────────────────────────────────────────

export type StreamEvent =
  | { type: "text-delta"; textDelta: string }
  | { type: "reasoning-delta"; reasoningDelta: string }
  | { type: "done"; finishReason: string; usage: UsageSummary };

// ── Embedding ──────────────────────────────────────────────────────

export interface EmbeddingParams {
  model: string;
  values: string[];
  providerRequestMetadata?: Record<string, unknown>;
}

export interface EmbeddingResult {
  embeddings: number[][];
  usage: UsageSummary;
}

// ── Image Generation ───────────────────────────────────────────────

export interface ImageGenerationParams {
  model: string;
  prompt: string;
  providerRequestMetadata?: Record<string, unknown>;
}

export interface GeneratedImage {
  mimeType: string;
  dataBase64?: string;
  url?: string;
}

export interface ImageGenerationResult {
  images: GeneratedImage[];
  usage: UsageSummary | null;
}

// ── Speech Synthesis ───────────────────────────────────────────────

export interface SpeechSynthesisParams {
  model: string;
  text: string;
  voice?: string;
  format?: string;
  providerRequestMetadata?: Record<string, unknown>;
}

export interface SpeechSynthesisResult {
  audio: { mimeType: string; data: Uint8Array };
  usage: UsageSummary | null;
}

// ── Transcription ──────────────────────────────────────────────────

export interface TranscriptionParams {
  model: string;
  audio: { data: Uint8Array; mimeType: string; fileName?: string };
  providerRequestMetadata?: Record<string, unknown>;
}

export interface TranscriptionResult {
  text: string;
  usage: UsageSummary | null;
}

// ── Request Context ────────────────────────────────────────────────

export interface ModelRequestContext {
  profile: ModelProfile;
  preset: PresetConfig | null;
  mode: OperationMode;
}

// ── Resolved Target ────────────────────────────────────────────────

export interface ResolvedTarget {
  profile: ModelProfile;
  preset: PresetConfig | null;
}

// ── Lifecycle Hook ─────────────────────────────────────────────────

export interface ProviderLifecycleHook {
  onRequestStart?(event: {
    provider: string;
    protocol: ProviderProtocol;
    mode: OperationMode;
    model: string;
    traceId?: string;
  }): void | Promise<void>;

  onRequestSuccess?(event: {
    provider: string;
    protocol: ProviderProtocol;
    mode: OperationMode;
    model: string;
    usage: UsageSummary | null;
    durationMs: number;
    traceId?: string;
  }): void | Promise<void>;

  onRequestError?(event: {
    provider: string;
    protocol: ProviderProtocol;
    mode: OperationMode;
    model: string;
    error: unknown;
    durationMs: number;
    traceId?: string;
  }): void | Promise<void>;
}

// ── Model Slot ────────────────────────────────────────────────────

export type ModelSlotId = "heavy" | "fast" | "balance" | "image" | (string & {});

export interface ModelSlotConfig {
  slotId: ModelSlotId;
  presetId: string;
  parameterOverrides?: ModelParameterOverrides;
}

export interface ModelParameterOverrides {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
}

export interface ModelSlotMap {
  slots: Record<string, ModelSlotConfig>;
  defaultSlot: string;
}

// ── AI Config (parsed from TOML) ───────────────────────────────────

export interface AiConfig {
  providers: Record<string, ProviderDefaults>;
  profiles: ModelProfile[];
  presets: PresetConfig[];
}
