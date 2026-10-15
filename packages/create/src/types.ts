/**
 * Types for the @covel/create package.
 */

import type {
  LLMAdapter,
  LLMUsageSummary,
  PluginPack,
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
  /** IDs already present in the destination; new manifests receive a free suffix. */
  readonly existingWorldIds?: readonly string[];
  /** Model slot to use (default: 'utility'; falls back to the first text slot). */
  readonly model?: string;
  /** Locale for generated content (default: 'zh-CN'). */
  readonly locale?: string;
  /** Structured player-facing brief for the generated experience/package. */
  readonly brief?: WorldCreationBrief;
  /** Loaded public data contracts available to generated world records. */
  readonly dataContracts?: readonly WorldGenerationDataContract[];
  /**
   * The plugin packs a brief may name (`brief.pack`): the server's catalogue.
   * The chosen one becomes the world's `pluginPolicy.preset`, and its
   * `defaultViewMode` the world's.
   */
  readonly packs?: readonly PluginPack[];
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
  /**
   * Receives the tokens of each model answer of the generation: every part,
   * every repeated request and the lore repair. The caller adds them up.
   */
  readonly onUsage?: (usage: LLMUsageSummary) => void;
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
  /** `world.yaml` with inline data: no `worldData`. */
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

/**
 * A record of the world's character file: the kernel's fields, plus one
 * record of each plugin contract that lives in character records, under the
 * field its plugin names (`characterField`).
 */
export interface GeneratedWorldCharacter {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly description?: string;
  readonly aliases?: readonly string[];
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly [characterField: string]: unknown;
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
  /**
   * Plugin that receives the data, unless every session has it already
   * (`kind: core`); the generated world adds it to `pluginPolicy.plus`.
   */
  readonly pluginId?: string;
  /** The receiver also wants each record projected into the lorebook. */
  readonly lorebook?: boolean;
  /**
   * The field of a character record that holds one record of this
   * contract (`authoring.characterField`). Its records are keyed by the id
   * of their character and written into that character's record.
   */
  readonly characterField?: string;
  /**
   * The file the receiving plugin names for this contract's records
   * (`authoring.source`), given only when that path is a convention: no
   * other contract names it. A world that has its records there needs no
   * entry in a descriptor for them.
   */
  readonly source?: {
    readonly kind: "yaml" | "json";
    readonly path: string;
    readonly localeArrayKeys?: readonly string[];
  };
}
