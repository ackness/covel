import type {
  ModelRequestContext,
  ProviderConfig,
  UsageSummary,
} from "../types.js";

export interface ImageGenerationParams {
  model: string;
  prompt: string;
  negativePrompt?: string;
  /** Canonical lowercase-x form, e.g. "1024x1024". Wires re-map separators. */
  size?: string;
  quality?: string;
  n?: number;
  background?: "transparent" | "opaque";
  providerRequestMetadata?: Record<string, unknown>;
}

/** Wire output: bytes, or a (possibly short-lived) URL the pipeline must ingest. */
export type GeneratedImageSource =
  | { kind: "bytes"; bytes: Uint8Array; mime: string }
  | { kind: "url"; url: string; mime: string };

export interface ImageGenerationResult {
  images: GeneratedImageSource[];
  usage: UsageSummary | null;
  /** e.g. "background=transparent unsupported by this wire, prompt-only". */
  warnings: string[];
}

/**
 * A pluggable image wire — one wire per provider request/response format.
 * Registered under an open string id (NOT an enum): plugins may register
 * additional wires without a framework PR.
 */
export interface ImageWire {
  readonly id: string;
  generate(
    config: ProviderConfig,
    params: ImageGenerationParams,
    context?: ModelRequestContext,
  ): Promise<ImageGenerationResult>;
}
