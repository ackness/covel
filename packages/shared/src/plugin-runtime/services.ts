import type { LLMUsageSummary } from "../index.js";
import type { LLMDiagnostics } from "../types/llm-diagnostics.js";
import type {
  EvaluationParams,
  EvaluationQuestions,
  EvaluationResult,
} from "../evaluation.js";

export type PluginEvaluationInput<
  Q extends EvaluationQuestions = EvaluationQuestions,
> = Omit<EvaluationParams<Q>, "model"> & {
  readonly presetId?: string;
  readonly signal?: AbortSignal;
};

/**
 * Minimal gateway facade exposed to function-runtime handlers and guards.
 *
 * This is a narrow, structural projection of `@covel/ai-provider`'s full
 * `Gateway` surface. Only the calls plugins actually need are exposed —
 * text/object generation, evaluation, media operations and slot resolution.
 * Novel operations can live in plugin services and reuse `resolveSlot` plus
 * vetted HTTP utilities without adding a method to this facade.
 *
 * `presetId` is a slot name (e.g. `default`, `image`, `fast`). `undefined`
 * resolves to the framework default for the relevant modality. API keys /
 * slot overrides remain request-scoped — the server wires them up when it
 * constructs the adapter; plugins never deal with them directly.
 *
 * The interface is deliberately structural (no class, no branded types) to
 * keep plugin execution independent of the loader and provider implementations.
 */
export interface PluginRuntimeGateway {
  /** Evaluate a closed set of questions; available when the host supports evaluation models. */
  evaluate?<const Q extends EvaluationQuestions>(
    input: PluginEvaluationInput<Q>,
  ): Promise<EvaluationResult<Q> & { provider?: string }>;

  generateText(input: {
    readonly presetId?: string;
    /** Host-selected instruction language, replaced for each runtime call. */
    readonly instructionLocale?: "en" | "zh";
    readonly prompt?: string;
    readonly system?: string;
    readonly messages?: readonly {
      readonly role: "system" | "user" | "assistant";
      readonly content: string;
    }[];
    readonly defaults?: import("../types/llm-adapter.js").LLMRequestDefaults;
    /**
     * Ask for a JSON reply of this shape. The provider's JSON mode is used
     * where it has one and the schema is added to the instructions; `text`
     * is still text, and the caller parses and checks it.
     */
    readonly responseFormat?: import("../types/llm-adapter.js").LLMResponseFormat;
    /** Output ceiling for this call; never raises the slot's configured budget. */
    readonly maxOutputTokens?: number;
    readonly providerRequestMetadata?: Readonly<Record<string, unknown>>;
    /** Namespaced options are validated by the host provider gateway. */
    readonly providerOptions?: Readonly<
      Record<string, Readonly<Record<string, unknown>>>
    >;
    readonly signal?: AbortSignal;
    /**
     * Cache-routing key, set by the host for a function runtime's calls
     * (`promptCacheKeyFor(sessionId, runtimeId)`); a value a plugin passes is
     * replaced.
     */
    readonly promptCacheKey?: string;
  }): Promise<{
    readonly text: string;
    readonly diagnostics?: LLMDiagnostics;
    readonly reasoningContent?: string;
    readonly finishReason: string;
    readonly usage: LLMUsageSummary;
    readonly model?: string;
    readonly provider?: string;
  }>;

  generateObject<T = unknown>(input: {
    readonly presetId?: string;
    /** Host-selected instruction language, replaced for each runtime call. */
    readonly instructionLocale?: "en" | "zh";
    readonly schema: Readonly<Record<string, unknown>>;
    readonly prompt?: string;
    readonly system?: string;
    readonly messages?: readonly {
      readonly role: "system" | "user" | "assistant";
      readonly content: string;
    }[];
    readonly defaults?: import("../types/llm-adapter.js").LLMRequestDefaults;
    /** Output ceiling for this call; never raises the slot's configured budget. */
    readonly maxOutputTokens?: number;
    readonly providerRequestMetadata?: Readonly<Record<string, unknown>>;
    readonly providerOptions?: Readonly<
      Record<string, Readonly<Record<string, unknown>>>
    >;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly object: T;
    readonly diagnostics?: LLMDiagnostics;
    readonly reasoningContent?: string;
    readonly finishReason: string;
    readonly usage: LLMUsageSummary;
    readonly model?: string;
    readonly provider?: string;
  }>;

  /**
   * Resolve a slot/preset id into its public configuration view. Returns
   * `null` when no slot can be resolved (typical when llm.toml is empty).
   *
   * Use this when your plugin owns the wire format (image generators,
   * audio, custom HTTP-based providers). The framework still picks the
   * right preset, applies request-scoped key/url overrides, and hands
   * back `{ baseUrl, apiKey, model, metadata, … }` — your handler then
   * implements its protocol with the vetted HTTP utilities.
   *
   * Use this for wire-level control (custom polling, novel response shape,
   * vendor-specific params, or non-text modalities).
   */
  resolveSlot(input: {
    readonly presetId?: string;
    /** Defaults to "text"; pass "image" / "embedding" / "speech" / "transcription" / "music" for non-text slots. */
    readonly fallbackTag?: string;
  }): ResolvedSlotForPlugin | null;

  /**
   * Low-level image generation returning raw sources (bytes/URLs) without
   * media persistence. Framework-internal building block for ctx.images —
   * plugins should prefer ctx.images.generate.
   */
  generateImage?(input: {
    presetId?: string;
    prompt: string;
    negativePrompt?: string;
    size?: string;
    quality?: string;
    n?: number;
    background?: "transparent" | "opaque";
    signal?: AbortSignal;
  }): Promise<{
    /** Non-secret identity of the target actually used for this generation. */
    target: ImageGenerationTarget;
    images: ReadonlyArray<
      | { kind: "bytes"; bytes: Uint8Array; mime: string }
      | { kind: "url"; url: string; mime: string }
    >;
    /** Tokens the provider reported; absent for a model billed another way. */
    usage?: LLMUsageSummary | null;
    model?: string;
    provider?: string;
    warnings: readonly string[];
  }>;

  /**
   * Low-level speech synthesis returning raw audio bytes without media
   * persistence. Framework-internal building block for ctx.speech —
   * plugins should prefer ctx.speech.generate.
   */
  synthesizeSpeech?(input: {
    presetId?: string;
    text: string;
    voice?: string;
    format?: string;
    signal?: AbortSignal;
  }): Promise<{
    audio: { mimeType: string; data: Uint8Array };
    /** Tokens the provider reported; absent for a model billed another way. */
    usage?: LLMUsageSummary | null;
    model?: string;
    provider?: string;
    warnings: readonly string[];
  }>;

  /**
   * Low-level music generation returning raw audio bytes without media
   * persistence. Framework-internal building block for ctx.music —
   * plugins should prefer ctx.music.generate.
   */
  composeMusic?(input: {
    presetId?: string;
    prompt: string;
    lyrics?: string;
    instrumental?: boolean;
    durationSeconds?: number;
    format?: string;
    signal?: AbortSignal;
  }): Promise<{
    audio: { mimeType: string; data: Uint8Array };
    /** Tokens the provider reported; absent for a model billed another way. */
    usage?: LLMUsageSummary | null;
    model?: string;
    provider?: string;
    warnings: readonly string[];
  }>;

  /**
   * Low-level transcription (STT). Framework-internal building block for
   * ctx.speech — plugins should prefer ctx.speech.transcribe.
   */
  transcribeAudio?(input: {
    presetId?: string;
    audio: { data: Uint8Array; mimeType: string; fileName?: string };
    signal?: AbortSignal;
  }): Promise<{
    text: string;
    usage?: LLMUsageSummary | null;
    model?: string;
    provider?: string;
    warnings: readonly string[];
  }>;
}

/**
 * Plugin-facing projection of `@covel/ai-provider`'s `ResolvedSlotConfig`.
 * Same shape, redeclared here so this package keeps zero dep on
 * @covel/ai-provider (avoids circular dep with @covel/runtime).
 */
export interface ResolvedSlotForPlugin {
  readonly presetId: string;
  readonly provider: string;
  readonly protocol: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly model: string;
  readonly tag: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  /**
   * Effective token limits the gateway applies to this slot, present when the
   * model declares a context window. Plugins that assemble their own long
   * prompts size them against `contextWindow - maxOutputTokens`.
   */
  readonly limits?: SlotTokenLimits;
}

export interface SlotTokenLimits {
  readonly contextWindow: number;
  /** Output budget after the player's slot override and model capacity. */
  readonly maxOutputTokens: number;
}

export type ImageGenerationTarget = Pick<
  ResolvedSlotForPlugin,
  "provider" | "model" | "protocol" | "baseUrl" | "metadata"
>;

/**
 * Narrow utility surface exposed to plugin function handlers via
 * `FunctionHandlerContext.utils`. Plugins use these to enforce the same
 * SSRF policy and retry semantics the framework's own adapters use,
 * without re-implementing them.
 *
 * Structural type: kept free of `@covel/ai-provider` imports so
 * `@covel/plugin-loader` stays at the bottom of the dep graph. The
 * runtime wires actual implementations from `@covel/ai-provider/plugin-utils`.
 */
export interface PluginRuntimeUtils {
  /**
   * SSRF-safe URL check. Returns `{ ok: true }` for safe URLs and
   * `{ ok: false, reason }` with a human-readable explanation for
   * blocked ones (private IPs, cloud metadata hosts, non-loopback http).
   */
  validateBaseUrl(url: string): {
    readonly ok: boolean;
    readonly reason?: string;
  };

  /**
   * fetch with exponential-backoff retry on 429 / 5xx. Honors `Retry-After`.
   * Does NOT retry on thrown fetch errors (DNS / network). Default
   * `maxRetries: 3`; pass 0 to disable.
   */
  fetchWithRetry(
    input: string | URL,
    init?: RequestInit & {
      readonly maxRetries?: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<Response>;
}

// The media capabilities are the public SDK's types; the host implements them.
export type {
  PluginIngestUrlOptions as IngestUrlOptions,
  PluginMedia as MediaContext,
  PluginImageGenerateInput as ImageGenerateInput,
  PluginImageGenerateOutput as ImageGenerateOutput,
  PluginImages as ImagesContext,
  PluginSpeechGenerateInput as SpeechGenerateInput,
  PluginSpeechGenerateOutput as SpeechGenerateOutput,
  PluginSpeechTranscribeInput as SpeechTranscribeInput,
  PluginSpeech as SpeechContext,
  PluginMusicGenerateInput as MusicGenerateInput,
  PluginMusicGenerateOutput as MusicGenerateOutput,
  PluginMusic as MusicContext,
  PluginAssetProgress as AssetProgressInput,
} from "@covel/plugin-handlers-utils";
