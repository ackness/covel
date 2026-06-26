/**
 * Types for the @covel/create package.
 */

import type { LLMAdapter } from "@covel/shared";

export interface CreateWorldLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** Options for creating a world package. Only `concept` is required. */
export interface CreateWorldOptions {
  /** LLM adapter for generation. */
  readonly llm: LLMAdapter;
  /** One-line concept (e.g., "赛博朋克风格的巨型垂直城市"). */
  readonly concept: string;
  /** Output directory to write files. */
  readonly outputDir: string;
  /** Model slot to use (default: 'default'). */
  readonly model?: string;
  /** Locale for generated content (default: 'zh-CN'). */
  readonly locale?: string;
  /** Optional abort signal for cancelling slow provider calls. */
  readonly signal?: AbortSignal;
  /** Per-attempt provider timeout in milliseconds. */
  readonly attemptTimeoutMs?: number;
  /** Optional logger for recording generation progress. */
  readonly logger?: CreateWorldLogger;
}

/** Result of a creation operation. */
export interface CreateResult {
  readonly success: boolean;
  /** Files written (relative to outputDir). */
  readonly files: readonly string[];
  /** Validation errors (if any). */
  readonly errors?: readonly string[];
  /** The generated ID. */
  readonly id: string;
}
