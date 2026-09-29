/**
 * Types for the @covel/create package.
 */

import type { LLMAdapter, WorldCreationBrief } from "@covel/shared";
import type { PromptLoader } from "@covel/context";

export interface CreateWorldLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** Generate and validate a world without choosing a persistence backend. */
export interface CreateWorldOptions {
  /** LLM adapter for generation. */
  readonly llm: LLMAdapter;
  /** Core concept or longer creative direction. */
  readonly concept: string;
  /** Model slot to use (default: 'default'). */
  readonly model?: string;
  /** Locale for generated content (default: 'zh-CN'). */
  readonly locale?: string;
  /** Structured player-facing brief for the generated experience/package. */
  readonly brief?: WorldCreationBrief;
  /** Loaded public data contracts available to generated world records. */
  readonly dataContracts?: readonly WorldGenerationDataContract[];
  /** Optional abort signal for cancelling slow provider calls. */
  readonly signal?: AbortSignal;
  /** Per-attempt generation timeout; a targeted lore repair shares this budget. */
  readonly attemptTimeoutMs?: number;
  /** Optional logger for recording generation progress. */
  readonly logger?: CreateWorldLogger;
  /** Template source shared by generation and repair for this invocation. */
  readonly loadPrompt?: PromptLoader;
}

/** Validated, portable generation result. File export never mutates it. */
export interface GeneratedWorld {
  readonly id: string;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly lore: string;
  readonly locale: string;
  readonly packageContent: GeneratedWorldPackageContent;
}

export type CreateResult =
  | (GeneratedWorld & { readonly success: true; readonly errors?: never })
  | {
      readonly success: false;
      readonly id: "unknown";
      readonly errors: readonly string[];
    };

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

export interface GeneratedMemoryDefinition {
  readonly label: string;
  readonly displayName: string;
  readonly extractionHint: string;
  readonly icon?: string;
  readonly maxChars?: number;
}

export interface GeneratedWorldPackageContent {
  readonly contractData?: readonly GeneratedContractData[];
  readonly characters: readonly GeneratedWorldCharacter[];
  readonly lorebook: readonly GeneratedWorldLorebookEntry[];
  readonly rules: readonly GeneratedWorldLorebookEntry[];
}

/** Portable authored data; key equals the record's id field. */
export interface GeneratedContractData {
  readonly contract: string;
  readonly key: string;
  readonly value: Readonly<Record<string, unknown>>;
}

export interface WorldGenerationDataContract {
  readonly contract: string;
  readonly schema: Readonly<Record<string, unknown>>;
  /** The caller compiles the loaded contract schema; create owns no gameplay schema. */
  readonly validate: (value: unknown) => boolean;
}
