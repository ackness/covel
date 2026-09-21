import type { LLMUsageSummary, MediaRef } from "../index.js";
import type { FunctionHandlerContext } from "./handler.js";
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
    readonly prompt?: string;
    readonly system?: string;
    readonly messages?: readonly {
      readonly role: "system" | "user" | "assistant";
      readonly content: string;
    }[];
    readonly providerRequestMetadata?: Readonly<Record<string, unknown>>;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly text: string;
    readonly reasoningContent?: string;
    readonly finishReason: string;
    readonly usage: LLMUsageSummary;
    readonly model?: string;
    readonly provider?: string;
  }>;

  generateObject<T = unknown>(input: {
    readonly presetId?: string;
    readonly schema: Readonly<Record<string, unknown>>;
    readonly prompt?: string;
    readonly system?: string;
    readonly messages?: readonly {
      readonly role: "system" | "user" | "assistant";
      readonly content: string;
    }[];
    readonly providerRequestMetadata?: Readonly<Record<string, unknown>>;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly object: T;
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
    /** Defaults to "text"; pass "image" / "embedding" / "speech" / "transcription" for non-text slots. */
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
    images: ReadonlyArray<
      | { kind: "bytes"; bytes: Uint8Array; mime: string }
      | { kind: "url"; url: string; mime: string }
    >;
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
}

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

export interface IngestUrlOptions {
  /** Maximum response bytes accepted before the download is aborted. */
  readonly maxBytes?: number;
  /** End-to-end timeout for the ingest request, including redirects. */
  readonly timeoutMs?: number;
  /** MIME allow-list. Supports exact matches and family wildcards such as `image/*`. */
  readonly allowedMimes?: readonly string[];
  /** Abort signal forwarded from the handler or turn runtime. */
  readonly signal?: AbortSignal;
  /** Additional metadata persisted with the media object. */
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface MediaContext {
  put(
    blob: Uint8Array | Blob,
    mime: string,
    meta?: Readonly<Record<string, unknown>>,
  ): Promise<MediaRef>;
  get(ref: MediaRef): Promise<Uint8Array | Blob>;
  resolveUrl(ref: MediaRef): Promise<string>;
  ingestUrl(url: string, opts?: IngestUrlOptions): Promise<MediaRef>;
}

export interface ImageGenerateInput {
  /** Slot name; defaults to image-tag resolution. */
  readonly presetId?: string;
  readonly prompt: string;
  readonly negativePrompt?: string;
  readonly size?: string;
  readonly quality?: string;
  readonly n?: number;
  readonly background?: "transparent" | "opaque";
  /**
   * Business metadata persisted onto the MediaRef (kind / sceneId /
   * characterId / variant …). `pluginId` and `promptHash` are injected by
   * the framework and cannot be overridden. `metadata` does not participate
   * in dedup; the persisted record keeps the first call's metadata, but a
   * cache hit returns THIS call's metadata on the ref so each consumer
   * indexes by its own values.
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Abort signal forwarded to the provider call. Not part of promptHash. */
  readonly signal?: AbortSignal;
}

export interface ImageGenerateOutput {
  readonly refs: readonly MediaRef[];
  readonly warnings: readonly string[];
  /** True when promptHash matched an existing asset and no provider call was made. */
  readonly cached: boolean;
}

/**
 * First-class image generation for function runtimes. Prefer this over
 * `gateway.resolveSlot()` + hand-rolled HTTP: the framework picks the wire,
 * stores bytes into the media library, stamps unified metadata, and
 * deduplicates identical prompts (promptHash).
 */
export interface ImagesContext {
  generate(input: ImageGenerateInput): Promise<ImageGenerateOutput>;
}

export interface SpeechGenerateInput {
  /** Slot name; defaults to speech-tag resolution. */
  readonly presetId?: string;
  readonly text: string;
  readonly voice?: string;
  readonly format?: string;
  /**
   * Business metadata persisted onto the MediaRef. Same contract as
   * ctx.images: `pluginId` and `promptHash` are injected by the framework
   * and cannot be overridden; metadata does not participate in dedup.
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Abort signal forwarded to the provider call. Not part of promptHash. */
  readonly signal?: AbortSignal;
}

export interface SpeechGenerateOutput {
  /** Always a single ref today; array keeps the shape symmetric with images. */
  readonly refs: readonly MediaRef[];
  readonly warnings: readonly string[];
  /** True when promptHash matched an existing asset and no provider call was made. */
  readonly cached: boolean;
}

export interface SpeechTranscribeInput {
  /** Slot name; defaults to transcription-tag resolution. */
  readonly presetId?: string;
  /** A MediaRef of already-stored audio (common path) or raw bytes. */
  readonly audio:
    | MediaRef
    | {
        readonly data: Uint8Array;
        readonly mimeType: string;
        readonly fileName?: string;
      };
  readonly signal?: AbortSignal;
}

/**
 * First-class speech pipeline for function runtimes — TTS with the same
 * dedup + MediaStore persistence contract as ctx.images, plus STT.
 */
export interface SpeechContext {
  generate(input: SpeechGenerateInput): Promise<SpeechGenerateOutput>;
  /** No dedup: output is plain text returned to the handler, nothing persisted. */
  transcribe(input: SpeechTranscribeInput): Promise<{
    readonly text: string;
    readonly warnings: readonly string[];
  }>;
}

export interface AssetProgressInput {
  /** Stable asset/job id when the plugin has one before final MediaRef commit. */
  readonly assetId?: string;
  /** Producer-defined phase, e.g. queued, generating, uploading, finalizing. */
  readonly phase: string;
  /** Numeric progress percentage from 0 to 100. */
  readonly percent?: number;
  /** Optional human-readable status text for debug surfaces. */
  readonly message?: string;
  /** Modality tag that will also appear on the final asset.generate payload. */
  readonly modality?: string;
  /** Provider/job metadata. Keep this lightweight; final assets still use MediaRef. */
  readonly meta?: Readonly<Record<string, unknown>>;
}
