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

// ── Prompt Cache Strategy (S2-T3) ─────────────────────────────────

/**
 * How a provider handles prompt caching.
 *
 * Per §A15 of the improvement plan, all major LLM providers support some
 * form of prompt caching but the ergonomics differ:
 *
 * - `anthropic-explicit` — Anthropic Messages API requires the client to
 *   attach `cache_control: { type: 'ephemeral' }` to specific content
 *   blocks. Up to 4 breakpoints are allowed per request. The adapter
 *   turns the sentinel-delimited `systemPrompt` string into a
 *   multi-block `system` array with cache hints on the stable segments.
 * - `auto-prefix` — OpenAI, DeepSeek, and Qwen transparently cache any
 *   prompt prefix they see repeatedly. The adapter needs no change; the
 *   only requirement is that prefixes stay byte-stable across turns,
 *   which the S2-T1 three-tier assembler already guarantees.
 * - `none` — fallback for providers with no prompt caching support.
 *   Adapters behave exactly as they did before S2-T3.
 */
export type CacheStrategy = 'anthropic-explicit' | 'auto-prefix' | 'none';

// ── Provider Config ────────────────────────────────────────────────

export interface ProviderConfig {
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  /** Abort signal for request cancellation. */
  signal?: AbortSignal;
  /**
   * Prompt cache strategy for this provider (S2-T3).
   *
   * Filled in by the provider registry based on the resolved protocol;
   * callers do not normally set this directly. When omitted or set to
   * `"none"` the adapter uses its pre-S2-T3 request construction.
   */
  cacheStrategy?: CacheStrategy;
}

// ── Provider Defaults (from TOML [providers.*]) ────────────────────

export interface ProviderDefaults {
  baseUrl?: string;
  protocol?: ProviderProtocol;
  headers?: Record<string, string>;
}

// ── Per-Request Slot Overrides ─────────────────────────────────────

/**
 * Minimal preset definition accepted from untrusted request contexts
 * (browser `X-Slot-Config` header, ping body, etc.). Mirrors the shape
 * the frontend stores in `covel:customPresets`.
 */
export interface CustomPresetInput {
  id: string;
  name: string;
  provider: string;
  baseUrl?: string;
  model: string;
  protocol?: ProviderProtocol;
}

/**
 * Per-call overlay that transiently extends the gateway's view of slot
 * and preset configuration. Applied with reference counting so concurrent
 * requests can safely share the overlay ids without racing.
 *
 * Consumed by the gateway (see `applySlotOverlay`). Server-side request
 * middleware populates this from the `X-Slot-Config` header so custom
 * presets/slots that only live in the browser's localStorage propagate
 * into actual LLM calls rather than silently falling back to the first
 * text slot.
 */
export interface SlotOverridesInput {
  /** Slot-name → preset-id. Consulted before the server slotRegistry. */
  slotPresetOverrides?: Record<string, string>;
  /** Preset definitions added for the duration of the call. */
  customPresets?: CustomPresetInput[];
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
  defaultSlot?: string;
  providerRequestMetadata?: Record<string, unknown>;
  /** Multimodal capability descriptor. Auto-inferred or manually set. */
  capability?: ModelCapability;
  /** Capability tag for slot compatibility. */
  tag?: string;
  /**
   * Image generation API format. Carried from llm.toml `imageApi` field.
   * Only meaningful for image slots. Passed through to slot config and
   * ultimately to the adapter via providerRequestMetadata.imageFormat.
   */
  imageApi?: ImageApiFormat;
  /**
   * Embeddings request body format. Carried from llm.toml `embeddingFormat`
   * field. Only meaningful for embed slots (output includes "embedding").
   * The gateway merges this into providerRequestMetadata.embeddingFormat
   * so adapters can dispatch on it.
   */
  embeddingFormat?: EmbeddingFormat;
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
  | { type: "tool-call"; id: string; name: string; arguments: string }
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

// SlotTag was in @covel/shared v1 — inlined here after v2 type refactor
type SlotTag = "text" | "image" | "embed" | "speech" | string;

export type ImageApiFormat = "dashscope-wan" | "openai-chat";

/**
 * Embeddings request body format.
 * - "openai" (default): standard `{input: string[]}` shape accepted by
 *   OpenAI, Ollama (v1), most OpenRouter text-embedding models.
 * - "nemotron-multimodal": OpenRouter NVIDIA Nemotron multimodal embedding
 *   shape `{input: [{content: [{type: "text"|"image_url", ...}]}]}`.
 *   Phase 1 supports only text content parts; Phase 2 will add images.
 */
export type EmbeddingFormat = "openai" | "nemotron-multimodal";

export interface ModelSlotConfig {
  slotId: string;
  presetId: string;
  /** Capability tag — determines compatibility with runtime providerTag. */
  tag: SlotTag;
  parameterOverrides?: ModelParameterOverrides;
  /**
   * Image generation API format. Only used for slots with tag "image".
   * If omitted, the adapter defaults to "dalle" (standard /images/generations).
   */
  imageApi?: ImageApiFormat;
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
}

// ── AI Config (parsed from TOML) ───────────────────────────────────

export interface AiConfig {
  providers: Record<string, ProviderDefaults>;
  profiles: ModelProfile[];
  presets: PresetConfig[];
}
