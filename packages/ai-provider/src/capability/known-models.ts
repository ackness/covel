/**
 * Curated known-model database.
 *
 * Built from LiteLLM model_prices_and_context_window.json + OpenRouter /v1/models.
 * Covers the most common providers: OpenAI, Anthropic, Google, DeepSeek, Qwen, Mistral.
 *
 * Taxonomy follows OpenRouter's directional approach:
 * - input modalities = what the model ACCEPTS
 * - output modalities = what the model PRODUCES
 *
 * "image" in input (vision) ≠ "image" in output (image generation).
 * "audio" in input (transcription/understanding) ≠ "audio" in output (speech synthesis).
 */

import type {
  InputModality,
  OutputModality,
  ModelFeature,
  ModelPricing,
} from "../types.js";

// ── Known Model Entry ────────────────────────────────────────────

export interface KnownModelEntry {
  input: InputModality[];
  output: OutputModality[];
  features: ModelFeature[];
  contextWindow: number;
  maxOutputTokens: number;
  pricing?: ModelPricing;
}

// ── Database ─────────────────────────────────────────────────────

/**
 * Key format: lowercase `model-id`.
 * Also supports `provider/model-id` for disambiguation.
 *
 * Lookup order in resolver: exact model → provider/model → prefix match.
 */
export const KNOWN_MODELS: ReadonlyMap<string, KnownModelEntry> = new Map([

  // ── OpenAI ──────────────────────────────────────────────────────

  ["gpt-4o", {
    input: ["text", "image", "audio", "file"],
    output: ["text"],
    features: ["function_calling", "structured_output", "streaming", "vision", "web_search"],
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    pricing: { inputPerMToken: 2.5, outputPerMToken: 10 },
  }],

  ["gpt-4o-mini", {
    input: ["text", "image", "file"],
    output: ["text"],
    features: ["function_calling", "structured_output", "streaming", "vision"],
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    pricing: { inputPerMToken: 0.15, outputPerMToken: 0.6 },
  }],

  ["gpt-4o-audio-preview", {
    input: ["text", "image", "audio"],
    output: ["text", "audio"],
    features: ["function_calling", "structured_output", "streaming", "vision"],
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    pricing: { inputPerMToken: 2.5, outputPerMToken: 10, audioInputPerMToken: 100, audioOutputPerMToken: 200 },
  }],

  ["gpt-4-turbo", {
    input: ["text", "image"],
    output: ["text"],
    features: ["function_calling", "structured_output", "streaming", "vision"],
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
    pricing: { inputPerMToken: 10, outputPerMToken: 30 },
  }],

  ["gpt-4.1", {
    input: ["text", "image", "file"],
    output: ["text"],
    features: ["function_calling", "structured_output", "streaming", "vision"],
    contextWindow: 1_047_576,
    maxOutputTokens: 32_768,
    pricing: { inputPerMToken: 2, outputPerMToken: 8 },
  }],

  ["gpt-4.1-mini", {
    input: ["text", "image", "file"],
    output: ["text"],
    features: ["function_calling", "structured_output", "streaming", "vision"],
    contextWindow: 1_047_576,
    maxOutputTokens: 32_768,
    pricing: { inputPerMToken: 0.4, outputPerMToken: 1.6 },
  }],

  ["gpt-4.1-nano", {
    input: ["text", "image", "file"],
    output: ["text"],
    features: ["function_calling", "structured_output", "streaming", "vision"],
    contextWindow: 1_047_576,
    maxOutputTokens: 32_768,
    pricing: { inputPerMToken: 0.1, outputPerMToken: 0.4 },
  }],

  ["o1", {
    input: ["text", "image"],
    output: ["text"],
    features: ["function_calling", "structured_output", "reasoning", "vision"],
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    pricing: { inputPerMToken: 15, outputPerMToken: 60 },
  }],

  ["o1-mini", {
    input: ["text"],
    output: ["text"],
    features: ["reasoning", "streaming"],
    contextWindow: 128_000,
    maxOutputTokens: 65_536,
    pricing: { inputPerMToken: 3, outputPerMToken: 12 },
  }],

  ["o3", {
    input: ["text", "image"],
    output: ["text"],
    features: ["function_calling", "structured_output", "reasoning", "vision"],
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    pricing: { inputPerMToken: 10, outputPerMToken: 40 },
  }],

  ["o3-mini", {
    input: ["text"],
    output: ["text"],
    features: ["function_calling", "structured_output", "reasoning", "streaming"],
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    pricing: { inputPerMToken: 1.1, outputPerMToken: 4.4 },
  }],

  ["o4-mini", {
    input: ["text", "image"],
    output: ["text"],
    features: ["function_calling", "structured_output", "reasoning", "vision", "streaming"],
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    pricing: { inputPerMToken: 1.1, outputPerMToken: 4.4 },
  }],

  // OpenAI image generation (text/image input → image output)
  ["dall-e-3", {
    input: ["text"],
    output: ["image"],
    features: [],
    contextWindow: 4_000,
    maxOutputTokens: 0,
    pricing: { perImage: 0.04 },
  }],

  ["gpt-image-1", {
    input: ["text", "image"],
    output: ["image", "text"],
    features: [],
    contextWindow: 32_000,
    maxOutputTokens: 0,
    pricing: { inputPerMToken: 5, outputPerMToken: 40 },
  }],

  // OpenAI TTS (text input → audio output)
  ["tts-1", {
    input: ["text"],
    output: ["audio"],
    features: [],
    contextWindow: 4_096,
    maxOutputTokens: 0,
  }],

  ["tts-1-hd", {
    input: ["text"],
    output: ["audio"],
    features: [],
    contextWindow: 4_096,
    maxOutputTokens: 0,
  }],

  // OpenAI Whisper (audio input → text output)
  ["whisper-1", {
    input: ["audio"],
    output: ["text"],
    features: [],
    contextWindow: 0,
    maxOutputTokens: 0,
  }],

  // OpenAI embeddings
  ["text-embedding-3-small", {
    input: ["text"],
    output: ["embedding"],
    features: [],
    contextWindow: 8_191,
    maxOutputTokens: 0,
    pricing: { inputPerMToken: 0.02 },
  }],

  ["text-embedding-3-large", {
    input: ["text"],
    output: ["embedding"],
    features: [],
    contextWindow: 8_191,
    maxOutputTokens: 0,
    pricing: { inputPerMToken: 0.13 },
  }],

  // ── Ollama local embeddings ─────────────────────────────────────
  // Dimensions vary by model variant; contextWindow is the prompt cap.

  ["nomic-embed-text", {
    input: ["text"],
    output: ["embedding"],
    features: [],
    contextWindow: 8_192,
    maxOutputTokens: 0,
  }],

  ["nomic-embed-text-v2-moe", {
    input: ["text"],
    output: ["embedding"],
    features: [],
    contextWindow: 8_192,
    maxOutputTokens: 0,
  }],

  // ── OpenRouter multimodal embeddings ────────────────────────────
  // NVIDIA Nemotron multimodal embedding — accepts both text and
  // image_url content parts. Shape requires the "nemotron-multimodal"
  // embeddingFormat dispatch in the adapter.

  ["nvidia/llama-nemotron-embed-vl-1b-v2:free", {
    input: ["text", "image"],
    output: ["embedding"],
    features: ["vision"],
    contextWindow: 8_192,
    maxOutputTokens: 0,
  }],

  // ── Anthropic ──────────────────────────────────────────────────

  ["claude-sonnet-4-20250514", {
    input: ["text", "image", "file"],
    output: ["text"],
    features: ["function_calling", "structured_output", "streaming", "vision", "prompt_caching", "reasoning", "computer_use"],
    contextWindow: 200_000,
    maxOutputTokens: 16_000,
    pricing: { inputPerMToken: 3, outputPerMToken: 15 },
  }],

  ["claude-opus-4-20250514", {
    input: ["text", "image", "file"],
    output: ["text"],
    features: ["function_calling", "structured_output", "streaming", "vision", "prompt_caching", "reasoning", "computer_use"],
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    pricing: { inputPerMToken: 15, outputPerMToken: 75 },
  }],

  ["claude-3-5-sonnet-20241022", {
    input: ["text", "image", "file"],
    output: ["text"],
    features: ["function_calling", "structured_output", "streaming", "vision", "prompt_caching", "computer_use"],
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    pricing: { inputPerMToken: 3, outputPerMToken: 15 },
  }],

  ["claude-3-5-haiku-20241022", {
    input: ["text", "image"],
    output: ["text"],
    features: ["function_calling", "structured_output", "streaming", "vision", "prompt_caching"],
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    pricing: { inputPerMToken: 0.8, outputPerMToken: 4 },
  }],

  ["claude-3-haiku-20240307", {
    input: ["text", "image"],
    output: ["text"],
    features: ["function_calling", "structured_output", "streaming", "vision"],
    contextWindow: 200_000,
    maxOutputTokens: 4_096,
    pricing: { inputPerMToken: 0.25, outputPerMToken: 1.25 },
  }],

  ["claude-3-opus-20240229", {
    input: ["text", "image"],
    output: ["text"],
    features: ["function_calling", "structured_output", "streaming", "vision"],
    contextWindow: 200_000,
    maxOutputTokens: 4_096,
    pricing: { inputPerMToken: 15, outputPerMToken: 75 },
  }],

  // ── Google Gemini ──────────────────────────────────────────────

  ["gemini-2.5-pro", {
    input: ["text", "image", "audio", "video", "file"],
    output: ["text"],
    features: ["function_calling", "structured_output", "streaming", "vision", "reasoning"],
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    pricing: { inputPerMToken: 1.25, outputPerMToken: 10 },
  }],

  ["gemini-2.5-flash", {
    input: ["text", "image", "audio", "video", "file"],
    output: ["text"],
    features: ["function_calling", "structured_output", "streaming", "vision", "reasoning"],
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    pricing: { inputPerMToken: 0.15, outputPerMToken: 0.6 },
  }],

  ["gemini-2.0-flash", {
    input: ["text", "image", "audio", "video", "file"],
    output: ["text", "image"],
    features: ["function_calling", "structured_output", "streaming", "vision", "web_search"],
    contextWindow: 1_048_576,
    maxOutputTokens: 8_192,
    pricing: { inputPerMToken: 0.1, outputPerMToken: 0.4 },
  }],

  ["gemini-1.5-pro", {
    input: ["text", "image", "audio", "video", "file"],
    output: ["text"],
    features: ["function_calling", "structured_output", "streaming", "vision"],
    contextWindow: 2_097_152,
    maxOutputTokens: 8_192,
    pricing: { inputPerMToken: 1.25, outputPerMToken: 5 },
  }],

  ["gemini-1.5-flash", {
    input: ["text", "image", "audio", "video", "file"],
    output: ["text"],
    features: ["function_calling", "structured_output", "streaming", "vision"],
    contextWindow: 1_048_576,
    maxOutputTokens: 8_192,
    pricing: { inputPerMToken: 0.075, outputPerMToken: 0.3 },
  }],

  // ── DeepSeek ───────────────────────────────────────────────────

  ["deepseek-chat", {
    input: ["text"],
    output: ["text"],
    features: ["function_calling", "structured_output", "streaming"],
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    pricing: { inputPerMToken: 0.27, outputPerMToken: 1.1 },
  }],

  ["deepseek-reasoner", {
    input: ["text"],
    output: ["text"],
    features: ["streaming", "reasoning"],
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    pricing: { inputPerMToken: 0.55, outputPerMToken: 2.19 },
  }],

  // ── Qwen (DashScope) ──────────────────────────────────────────

  ["qwen-plus", {
    input: ["text"],
    output: ["text"],
    features: ["function_calling", "structured_output", "streaming"],
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    pricing: { inputPerMToken: 0.8, outputPerMToken: 2 },
  }],

  ["qwen-turbo", {
    input: ["text"],
    output: ["text"],
    features: ["function_calling", "structured_output", "streaming"],
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    pricing: { inputPerMToken: 0.3, outputPerMToken: 0.6 },
  }],

  ["qwen-max", {
    input: ["text"],
    output: ["text"],
    features: ["function_calling", "structured_output", "streaming"],
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    pricing: { inputPerMToken: 2.4, outputPerMToken: 9.6 },
  }],

  ["qwen-vl-plus", {
    input: ["text", "image", "video"],
    output: ["text"],
    features: ["function_calling", "streaming", "vision"],
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    pricing: { inputPerMToken: 0.8, outputPerMToken: 2 },
  }],

  ["qwen-vl-max", {
    input: ["text", "image", "video"],
    output: ["text"],
    features: ["function_calling", "streaming", "vision"],
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    pricing: { inputPerMToken: 3, outputPerMToken: 6.5 },
  }],

  ["qwen3-235b-a22b", {
    input: ["text"],
    output: ["text"],
    features: ["function_calling", "structured_output", "streaming", "reasoning"],
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    pricing: { inputPerMToken: 4, outputPerMToken: 16 },
  }],

  ["qwen3-30b-a3b", {
    input: ["text"],
    output: ["text"],
    features: ["function_calling", "structured_output", "streaming", "reasoning"],
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    pricing: { inputPerMToken: 0.7, outputPerMToken: 2.8 },
  }],

  ["qwen3.5-flash", {
    input: ["text"],
    output: ["text"],
    features: ["function_calling", "structured_output", "streaming", "reasoning"],
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    pricing: { inputPerMToken: 0.14, outputPerMToken: 0.56 },
  }],

  // Qwen omni models (multimodal I/O)
  ["qwen-omni-turbo", {
    input: ["text", "image", "audio", "video"],
    output: ["text", "audio"],
    features: ["function_calling", "streaming", "vision"],
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    pricing: { inputPerMToken: 0.6, outputPerMToken: 1.5, audioInputPerMToken: 1.8, audioOutputPerMToken: 4 },
  }],

  ["qwen2.5-omni-7b", {
    input: ["text", "image", "audio", "video"],
    output: ["text", "audio"],
    features: ["streaming", "vision"],
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
  }],

  // Qwen audio
  ["qwen-audio-turbo", {
    input: ["text", "audio"],
    output: ["text"],
    features: ["streaming"],
    contextWindow: 8_192,
    maxOutputTokens: 4_096,
  }],

  // ── Mistral ────────────────────────────────────────────────────

  ["mistral-large-latest", {
    input: ["text", "image"],
    output: ["text"],
    features: ["function_calling", "structured_output", "streaming", "vision"],
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    pricing: { inputPerMToken: 2, outputPerMToken: 6 },
  }],

  ["mistral-small-latest", {
    input: ["text", "image"],
    output: ["text"],
    features: ["function_calling", "structured_output", "streaming", "vision"],
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    pricing: { inputPerMToken: 0.1, outputPerMToken: 0.3 },
  }],

  ["codestral-latest", {
    input: ["text"],
    output: ["text"],
    features: ["function_calling", "streaming"],
    contextWindow: 262_144,
    maxOutputTokens: 8_192,
    pricing: { inputPerMToken: 0.3, outputPerMToken: 0.9 },
  }],

  ["pixtral-large-latest", {
    input: ["text", "image"],
    output: ["text"],
    features: ["function_calling", "structured_output", "streaming", "vision"],
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    pricing: { inputPerMToken: 2, outputPerMToken: 6 },
  }],

  // ── Groq ───────────────────────────────────────────────────────

  ["groq/llama-3.3-70b-versatile", {
    input: ["text"],
    output: ["text"],
    features: ["function_calling", "structured_output", "streaming"],
    contextWindow: 131_072,
    maxOutputTokens: 32_768,
    pricing: { inputPerMToken: 0.59, outputPerMToken: 0.79 },
  }],

  ["groq/llama-3.1-8b-instant", {
    input: ["text"],
    output: ["text"],
    features: ["function_calling", "structured_output", "streaming"],
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    pricing: { inputPerMToken: 0.05, outputPerMToken: 0.08 },
  }],

  // ── Together / Open Source ─────────────────────────────────────

  ["meta-llama/llama-3.1-405b-instruct", {
    input: ["text"],
    output: ["text"],
    features: ["function_calling", "streaming"],
    contextWindow: 131_072,
    maxOutputTokens: 4_096,
  }],

  ["meta-llama/llama-3.1-70b-instruct", {
    input: ["text"],
    output: ["text"],
    features: ["function_calling", "streaming"],
    contextWindow: 131_072,
    maxOutputTokens: 4_096,
  }],

  // ── Image generation (non-OpenAI) ──────────────────────────────

  ["stability/stable-diffusion-xl", {
    input: ["text"],
    output: ["image"],
    features: [],
    contextWindow: 0,
    maxOutputTokens: 0,
  }],

  ["flux-1.1-pro", {
    input: ["text", "image"],
    output: ["image"],
    features: [],
    contextWindow: 0,
    maxOutputTokens: 0,
    pricing: { perImage: 0.04 },
  }],
]);

/**
 * Alias map: common model name variants → canonical key in KNOWN_MODELS.
 */
export const MODEL_ALIASES: ReadonlyMap<string, string> = new Map([
  // OpenAI aliases
  ["gpt-4o-2024-11-20", "gpt-4o"],
  ["gpt-4o-2024-08-06", "gpt-4o"],
  ["gpt-4o-2024-05-13", "gpt-4o"],
  ["gpt-4o-mini-2024-07-18", "gpt-4o-mini"],
  ["chatgpt-4o-latest", "gpt-4o"],
  ["gpt-4-turbo-2024-04-09", "gpt-4-turbo"],
  ["gpt-4-turbo-preview", "gpt-4-turbo"],

  // Anthropic aliases
  ["claude-sonnet-4-20250514", "claude-sonnet-4-20250514"],
  ["claude-3-5-sonnet-latest", "claude-3-5-sonnet-20241022"],
  ["claude-3-5-sonnet-v2", "claude-3-5-sonnet-20241022"],
  ["claude-3-5-haiku-latest", "claude-3-5-haiku-20241022"],
  ["claude-3-haiku", "claude-3-haiku-20240307"],
  ["claude-3-opus", "claude-3-opus-20240229"],

  // Gemini aliases
  ["gemini-2.5-pro-preview-05-06", "gemini-2.5-pro"],
  ["gemini-2.5-flash-preview-04-17", "gemini-2.5-flash"],
  ["gemini-2.0-flash-001", "gemini-2.0-flash"],
  ["gemini-1.5-pro-latest", "gemini-1.5-pro"],
  ["gemini-1.5-flash-latest", "gemini-1.5-flash"],

  // DeepSeek aliases
  ["deepseek-chat-v3", "deepseek-chat"],
  ["deepseek-v3", "deepseek-chat"],
  ["deepseek-r1", "deepseek-reasoner"],

  // Qwen aliases (DashScope uses these model IDs)
  ["qwen-plus-latest", "qwen-plus"],
  ["qwen-turbo-latest", "qwen-turbo"],
  ["qwen-max-latest", "qwen-max"],
  ["qwen-vl-plus-latest", "qwen-vl-plus"],
  ["qwen-vl-max-latest", "qwen-vl-max"],
  ["qwen3-235b", "qwen3-235b-a22b"],
  ["qwen3-30b", "qwen3-30b-a3b"],
  ["qwen2.5-omni-7b-instruct", "qwen2.5-omni-7b"],
  ["qwen-omni-turbo-latest", "qwen-omni-turbo"],
  ["qwen3.5-flash-latest", "qwen3.5-flash"],

  // Mistral aliases
  ["mistral-large-2411", "mistral-large-latest"],
  ["mistral-small-2503", "mistral-small-latest"],
  ["codestral-2501", "codestral-latest"],
  ["pixtral-large-2411", "pixtral-large-latest"],
]);
