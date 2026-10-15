/**
 * Media capabilities a host gives function runtimes: `ctx.media`,
 * `ctx.images`, `ctx.speech`, `ctx.music` and `ctx.assetProgress`. The host
 * implements these exact types; each one is present only when the host has
 * the store and model it needs, so check before use.
 */

/** A stored media object. `id` is the SHA-256 of the content. */
export type PluginMediaRef = {
  readonly id: string;
  /** MIME type, e.g. image/png, audio/wav, video/mp4. */
  readonly mime: string;
  /** Byte size; useful for budgeting and progress. */
  readonly size: number;
  /** Optional pre-signed URL. Resolve by id when absent. */
  readonly url?: string;
  /** Free-form metadata: dimensions, duration, provider ids, etc. */
  readonly meta?: Readonly<Record<string, unknown>>;
};

export interface PluginIngestUrlOptions {
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

/** The session's media library. */
export interface PluginMedia {
  put(
    blob: Uint8Array | Blob,
    mime: string,
    meta?: Readonly<Record<string, unknown>>,
  ): Promise<PluginMediaRef>;
  get(ref: PluginMediaRef): Promise<Uint8Array | Blob>;
  ingestUrl(
    url: string,
    opts?: PluginIngestUrlOptions,
  ): Promise<PluginMediaRef>;
}

export interface PluginImageGenerateInput {
  /** Exact image role or preset name; defaults to the "image" role. */
  readonly presetId?: string;
  readonly prompt: string;
  readonly negativePrompt?: string;
  readonly size?: string;
  readonly quality?: string;
  readonly n?: number;
  readonly background?: "transparent" | "opaque";
  /**
   * Business metadata persisted onto the media ref (kind / sceneId /
   * characterId / variant …). `pluginId` and `promptHash` are injected by
   * the host and cannot be overridden. `metadata` does not participate in
   * dedup; the persisted record keeps the first call's metadata, but a cache
   * hit returns THIS call's metadata on the ref so each consumer indexes by
   * its own values.
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Abort signal forwarded to the provider call. Not part of promptHash. */
  readonly signal?: AbortSignal;
}

export interface PluginImageGenerateOutput {
  readonly refs: readonly PluginMediaRef[];
  readonly warnings: readonly string[];
  /** True when the resolved model, wire settings and prompt matched an existing asset. */
  readonly cached: boolean;
}

/**
 * Image generation: the host picks the wire, stores the bytes in the media
 * library, stamps metadata, and deduplicates identical prompts.
 */
export interface PluginImages {
  /** Check the exact image role without generating or making a provider request. */
  isAvailable(presetId?: string): boolean;
  generate(input: PluginImageGenerateInput): Promise<PluginImageGenerateOutput>;
}

export interface PluginSpeechGenerateInput {
  /** Slot name; defaults to speech-tag resolution. */
  readonly presetId?: string;
  readonly text: string;
  readonly voice?: string;
  readonly format?: string;
  /** Persisted onto the media ref, as for `images.generate`; not part of dedup. */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Abort signal forwarded to the provider call. Not part of promptHash. */
  readonly signal?: AbortSignal;
}

export interface PluginSpeechGenerateOutput {
  /** Always a single ref today; array keeps the shape symmetric with images. */
  readonly refs: readonly PluginMediaRef[];
  readonly warnings: readonly string[];
  /** True when promptHash matched an existing asset and no provider call was made. */
  readonly cached: boolean;
}

export interface PluginSpeechTranscribeInput {
  /** Slot name; defaults to transcription-tag resolution. */
  readonly presetId?: string;
  /** A ref of already-stored audio (common path) or raw bytes. */
  readonly audio:
    | PluginMediaRef
    | {
        readonly data: Uint8Array;
        readonly mimeType: string;
        readonly fileName?: string;
      };
  readonly signal?: AbortSignal;
}

/** Text to speech, stored and deduplicated as images are, plus transcription. */
export interface PluginSpeech {
  generate(
    input: PluginSpeechGenerateInput,
  ): Promise<PluginSpeechGenerateOutput>;
  /** No dedup: output is plain text returned to the handler, nothing persisted. */
  transcribe(input: PluginSpeechTranscribeInput): Promise<{
    readonly text: string;
    readonly warnings: readonly string[];
  }>;
}

export interface PluginMusicGenerateInput {
  /** Slot name; defaults to the `music` role, then any slot tagged `music`. */
  readonly presetId?: string;
  /** What the music should be: style, instruments, mood, tempo. */
  readonly prompt: string;
  /** Words to sing. Absent: the provider decides, or the piece has none. */
  readonly lyrics?: string;
  /** True asks for a piece without vocals. */
  readonly instrumental?: boolean;
  /** Wanted length in seconds. A provider may round it or ignore it. */
  readonly durationSeconds?: number;
  readonly format?: string;
  /** Persisted onto the media ref, as for `speech.generate`; not part of dedup. */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Abort signal forwarded to the provider call. Not part of promptHash. */
  readonly signal?: AbortSignal;
}

export interface PluginMusicGenerateOutput {
  /** Always a single ref today; array keeps the shape symmetric with images. */
  readonly refs: readonly PluginMediaRef[];
  readonly warnings: readonly string[];
  /** True when promptHash matched an existing asset and no provider call was made. */
  readonly cached: boolean;
}

/**
 * Music generation, stored and deduplicated as speech is. A piece takes long
 * to generate: call it from a detached or background runtime, never in a turn.
 */
export interface PluginMusic {
  /** Check the music role without generating or making a provider request. */
  isAvailable(presetId?: string): boolean;
  generate(input: PluginMusicGenerateInput): Promise<PluginMusicGenerateOutput>;
}

/** One live progress report for an asset being generated (`ctx.assetProgress`). */
export interface PluginAssetProgress {
  /** Stable asset/job id when the plugin has one before the final ref is committed. */
  readonly assetId?: string;
  /** Producer-defined phase, e.g. queued, generating, uploading, finalizing. */
  readonly phase: string;
  /** Numeric progress percentage from 0 to 100. */
  readonly percent?: number;
  /** Optional human-readable status text for debug surfaces. */
  readonly message?: string;
  /** Modality tag that will also appear on the final asset.generate payload. */
  readonly modality?: string;
  /** Provider/job metadata. Keep this lightweight; final assets still use media refs. */
  readonly meta?: Readonly<Record<string, unknown>>;
}
