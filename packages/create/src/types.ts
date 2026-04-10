/**
 * Types for the @covel/create package.
 */

import type { LLMAdapter } from '@covel/runtime';

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
