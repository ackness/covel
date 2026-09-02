/**
 * Types for the @covel/create package.
 */

import type { LLMAdapter, WorldCreationBrief } from "@covel/shared";

export interface CreateWorldLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** Options for creating a world package. Only `concept` is required. */
export interface CreateWorldOptions {
  /** LLM adapter for generation. */
  readonly llm: LLMAdapter;
  /** Core concept or longer creative direction. */
  readonly concept: string;
  /** Output directory to write files. */
  readonly outputDir: string;
  /** Model slot to use (default: 'default'). */
  readonly model?: string;
  /** Locale for generated content (default: 'zh-CN'). */
  readonly locale?: string;
  /** Structured player-facing brief for the generated experience/package. */
  readonly brief?: WorldCreationBrief;
  /** Optional abort signal for cancelling slow provider calls. */
  readonly signal?: AbortSignal;
  /** Per-attempt generation timeout; a targeted lore repair shares this budget. */
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
  /** Portable text content used when the generated file package is transient. */
  readonly packageContent?: GeneratedWorldPackageContent;
}

export interface GeneratedWorldCharacter {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly role?: string;
  readonly type?: string;
  readonly description?: string;
  readonly aliases?: readonly string[];
  readonly tags?: readonly string[];
  readonly attributes?: Readonly<Record<string, unknown>>;
  readonly persona?: Readonly<Record<string, unknown>>;
  readonly dialogueExamples?: readonly Readonly<Record<string, unknown>>[];
  readonly scenarioDefaults?: Readonly<Record<string, unknown>>;
  readonly rules?: readonly Readonly<Record<string, unknown>>[];
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly instantiate?: Readonly<Record<string, unknown>>;
}

export interface GeneratedWorldLorebookEntry {
  readonly id: string;
  readonly content: string;
  readonly strategy?: "constant" | "selective";
  readonly keys?: readonly string[];
  readonly position?: "before_plugin" | "after_plugin";
  readonly insertionOrder?: number;
  readonly enabled?: boolean;
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface GeneratedWorldPackageContent {
  readonly characters: readonly GeneratedWorldCharacter[];
  readonly lorebook: readonly GeneratedWorldLorebookEntry[];
  readonly rules: readonly GeneratedWorldLorebookEntry[];
}
