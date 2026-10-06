/**
 * Types for the @covel/create package.
 */

import type {
  LLMAdapter,
  WorldCreationBrief,
  WorldGenerationPart,
} from "@covel/shared";
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
  /**
   * Longest wait for the next output of the model, in every request of the
   * generation. A request that keeps writing is not cut off.
   */
  readonly idleTimeoutMs?: number;
  /**
   * Receives the state of every part each time a part starts, grows, is
   * asked for again, or ends.
   */
  readonly onProgress?: (parts: readonly WorldGenerationPart[]) => void;
  /** Optional logger for recording generation progress. */
  readonly logger?: CreateWorldLogger;
  /** Template source shared by generation and repair for this invocation. */
  readonly loadPrompt?: PromptLoader;
  /**
   * Revise an existing world instead of creating one. The model gets the
   * current package and the request, and returns the same three sections;
   * a section it does not change comes back as the word `UNCHANGED` and is
   * taken from `current` as it is. The result goes through the same checks
   * as a new world and keeps the world's `id`.
   */
  readonly revision?: WorldRevision;
}

/** The current package of a world, in the sections the model writes. */
export interface WorldSections {
  /** `world.yaml` with inline data: no `worldData`, no `dimensionSources`. */
  readonly yaml: string;
  readonly lore: string;
  readonly packageYaml?: string;
}

export interface WorldRevision {
  readonly current: WorldSections;
  /** What the player asked for, in the player's words. */
  readonly instruction: string;
}

/** Validated, portable generation result. File export never mutates it. */
export interface GeneratedWorld {
  readonly id: string;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly lore: string;
  readonly locale: string;
  readonly packageContent: GeneratedWorldPackageContent;
  /**
   * What the result falls short of: content below the requested amount, or
   * parts that were dropped because they were invalid. The world is valid and
   * playable; these explain how it differs from the brief.
   */
  readonly warnings: readonly string[];
}

export type CreateResult =
  | (GeneratedWorld & { readonly success: true; readonly errors?: never })
  | {
      readonly success: false;
      readonly id: "unknown";
      readonly errors: readonly string[];
      /** The last request ended because the model stayed silent too long. */
      readonly idleTimeout?: true;
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
  /** Also project the record into the lorebook, as its receiver declares. */
  readonly lorebook?: true;
}

export interface WorldGenerationDataContract {
  readonly contract: string;
  readonly schema: Readonly<Record<string, unknown>>;
  /** The caller compiles the loaded contract schema; create owns no gameplay schema. */
  readonly validate: (value: unknown) => boolean;
  /** Authoring notes the receiving plugin declares for this content. */
  readonly title?: string;
  readonly hint?: string;
  readonly example?: unknown;
  /** Plugin that receives the data; the generated world requests it. */
  readonly pluginId?: string;
  /** The receiver also wants each record projected into the lorebook. */
  readonly lorebook?: boolean;
  /**
   * The file the receiving plugin names for this contract's records
   * (`authoring.source`), given only when that path is a convention: no
   * other contract names it. A world that has its records there needs no
   * entry in a descriptor for them.
   */
  readonly source?: {
    readonly kind: "yaml" | "json";
    readonly path: string;
  };
}
