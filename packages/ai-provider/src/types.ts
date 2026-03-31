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

// ── Model Tier ─────────────────────────────────────────────────────

export type ModelTier = "small" | "medium" | "large" | "embed-default";

// ── Provider Config ────────────────────────────────────────────────

export interface ProviderConfig {
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
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
  providerRequestMetadata?: Record<string, unknown>;
}

// ── Text Generation ────────────────────────────────────────────────

export interface TextGenerationParams {
  model: string;
  messages: TextMessage[];
  providerRequestMetadata?: Record<string, unknown>;
}

export interface TextMessage {
  role: string;
  content: string;
}

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
}

export interface TextGenerationResult {
  text: string;
  finishReason: string;
  usage: UsageSummary;
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

// ── AI Config (parsed from TOML) ───────────────────────────────────

export interface AiConfig {
  providers: Record<string, ProviderDefaults>;
  profiles: ModelProfile[];
  presets: PresetConfig[];
}
