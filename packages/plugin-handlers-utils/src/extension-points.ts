/**
 * Public SDK types for Covel extension points.
 *
 * Structural mirrors of the kernel contracts — this file must never import a
 * workspace package, so consumers can bundle the SDK into a standalone plugin
 * artifact and still typecheck without `@covel/*`. A compile-time alignment
 * module in `@covel/plugin-test-utils` keeps these shapes in lockstep with the
 * kernel zod schemas.
 */

import type { JsonValue, MediaReference, PluginDataReader } from "./types.js";
import type { PluginServiceContext } from "./plugin-api.js";
import type { PluginMessages } from "./messages.js";
import type {
  ExtensionDimensionSnapshot,
  ExtensionWorldDimensions,
} from "./world-dimensions.js";

export type I18nText = string | Readonly<Record<string, string>>;

// ── Contract identity ────────────────────────────────────────────

/** Ids of every kernel extension point. */
export type ExtensionPointId = keyof ExtensionPointIo;

/**
 * Versioned input/output contract of every kernel extension point, keyed by
 * point id. Mirror of `KernelExtensionPointIo` in `@covel/shared`.
 */
export type ExtensionPointIo = {
  readonly "history.compact@2": {
    readonly input: HistoryCompactInput;
    readonly output: HistoryCompactOutput;
  };
  readonly "media.image-flow@1": {
    readonly input: Record<string, never>;
    readonly output: MediaImageFlow;
  };
  readonly "prompt.history-transform@1": {
    readonly input: PromptHistoryTransformInput;
    readonly output: PromptHistoryTransformOutput;
  };
  readonly "prompt.segment@1": {
    readonly input: PromptSegmentInput;
    readonly output: PromptSegment[];
  };
  readonly "session.world-context@1": {
    readonly input: Record<string, never>;
    readonly output: SessionWorldContextOutput;
  };
  readonly "ui.slot@1": {
    readonly input: UiSlotProjectionInput;
    readonly output: UiSlotValue;
  };
};

// ── prompt.segment@1 ─────────────────────────────────────────────

export type PromptSegmentInput = {
  readonly turnId: string;
  readonly playerMessage: string;
};

export type PromptSegment = {
  readonly id: string;
  readonly content: string;
  readonly position:
    "system" | "pre-history" | "post-history" | { readonly depth: number };
  readonly role?: "system" | "user" | "assistant";
  readonly audience: "all" | "story" | "self" | { readonly contract: string };
  readonly volatility: "stable" | "session" | "turn";
  readonly order?: number;
  readonly providerPluginId?: string;
};

// ── prompt.history-transform@1 ───────────────────────────────────

export type ExtensionHistoryMessage = {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly sourceType: string;
  readonly sourcePluginId?: string;
  readonly sourceRuntimeId?: string;
  readonly role: string;
  readonly content: string;
  readonly name?: string;
  readonly order: number;
  readonly createdAt: string;
  readonly compactedAtTurnId?: string;
  readonly metadata?: unknown;
  readonly ui?: unknown;
  readonly pendingInput?: unknown;
};

export type PromptHistoryTransformInput = {
  readonly messages: readonly ExtensionHistoryMessage[];
  readonly turnId: string;
};

export type PromptHistoryTransformOutput = {
  readonly messages: readonly ExtensionHistoryMessage[];
};

// ── history.compact@2 ────────────────────────────────────────────

export type HistoryCompactSummary = {
  readonly id: string;
  readonly sessionId: string;
  readonly turnRangeStart: string;
  readonly turnRangeEnd: string;
  readonly content: string;
  readonly focusSections: readonly string[];
  readonly createdAt: string;
};

export type HistoryCompactInput = {
  readonly messages: readonly ExtensionHistoryMessage[];
  readonly existingSummaries: readonly HistoryCompactSummary[];
  readonly contextWindow: number;
  readonly inputWindow: number;
  readonly summaryBudget: {
    readonly maxTokens: number;
    readonly maxSegmentTokens: number;
    readonly maxSegments: number;
  };
  readonly estimatedTokens: number;
  readonly locale: string;
};

export type HistoryCompactOutput = {
  readonly summaries: readonly {
    readonly messageIds: readonly string[];
    readonly replacesSummaryIds: readonly string[];
    readonly content: string;
    readonly focusSections: readonly string[];
    readonly truncated?: boolean;
  }[];
} | null;

// ── media.image-flow@1 ───────────────────────────────────────────

export type MediaImageFlow = {
  readonly pluginId?: string;
  readonly entryRuntimeId: string;
  readonly assetRuntimeIds: readonly string[];
};

// ── session.world-context@1 ──────────────────────────────────────

export type SessionWorldContextOutput = {
  readonly schema?: Record<string, unknown>;
  readonly entries?: Record<string, unknown>;
  readonly dimensions?: ExtensionDimensionSnapshot;
  readonly dimensionRecovery?: {
    readonly editorRuntimeId: string;
    readonly trackerRuntimeId: string;
  };
  readonly dimensionProviderPluginId?: string;
};

// ── ui.slot@1 ────────────────────────────────────────────────────

export type UiSlotName =
  | "stage.backdrop@1"
  | "stage.cast@1"
  | "stage.dialogue@1"
  | "stage.choices@1"
  | "character.visual@1"
  | "session.summary@1"
  | "stage.music@1";

export type StageBackdropModel = {
  readonly sceneId?: string;
  readonly name?: string;
  readonly ref?: MediaReference;
  readonly variant?: "day" | "night";
  readonly label?: I18nText;
  readonly preload?: MediaReference[];
};

export type StageCastModel = {
  readonly actors: {
    readonly characterId: string;
    readonly displayName: string;
    readonly type?: string;
    readonly description?: string;
    readonly active?: boolean;
    readonly exiting?: boolean;
    readonly visual?: {
      readonly variantId?: string;
      readonly outfit?: string;
      readonly expression?: string;
      readonly pose?: string;
    };
    readonly position?:
      "left" | "center-left" | "center" | "center-right" | "right";
    readonly transition?:
      "none" | "fade" | "slide-left" | "slide-right" | "dissolve";
  }[];
  readonly retainWhenEmpty: boolean;
};

export type StageDialogueModel = {
  readonly turnId?: string;
  readonly paragraphSpeakers: (string | null)[];
};

export type StageChoicesModel = {
  readonly turnId?: string;
  readonly scene?: I18nText;
  readonly recap?: I18nText;
  readonly decision?: I18nText;
  readonly choices: {
    readonly id: string;
    readonly text: string;
    readonly label?: I18nText;
  }[];
};

export type CharacterVisualModel = {
  readonly characterId: string;
  readonly displayName?: string;
  readonly avatar?: MediaReference;
  readonly sprite?: MediaReference;
  readonly visuals?: {
    readonly defaultVariant?: string;
    readonly variants: {
      readonly id: string;
      readonly outfit?: string;
      readonly expression?: string;
      readonly pose?: string;
      readonly sprite: MediaReference;
      readonly stage?: {
        readonly scale?: number;
        readonly offsetX?: number;
        readonly offsetY?: number;
      };
    }[];
  };
};

export type CharacterVisualCollectionModel = {
  readonly characters: CharacterVisualModel[];
};

type SessionSummaryTone = "info" | "success" | "warning" | "danger";

/** One at-a-glance line: a text value, a gauge, or a short list. */
export type SessionSummaryEntry =
  | {
      readonly id: string;
      readonly label: I18nText;
      readonly kind: "text";
      readonly value: I18nText;
      readonly tone?: SessionSummaryTone;
    }
  | {
      readonly id: string;
      readonly label: I18nText;
      readonly kind: "meter";
      readonly value: number;
      readonly max: number;
      readonly min?: number;
      readonly tone?: SessionSummaryTone;
    }
  | {
      readonly id: string;
      readonly label: I18nText;
      readonly kind: "list";
      readonly items: I18nText[];
      /** Count of all items when `items` is only the first few. */
      readonly total?: number;
    };

export type SessionSummaryModel = {
  readonly entries: SessionSummaryEntry[];
};

/**
 * What should be playing behind the session now. State, not a command: the
 * player changes track when `trackId` changes and is silent without a `ref`.
 */
export type StageMusicModel = {
  readonly trackId?: string;
  readonly title?: I18nText;
  /** An audio asset. Absent: silence. */
  readonly ref?: MediaReference;
  /** Defaults to true. */
  readonly loop?: boolean;
  /** The author's level for this track (0–1), under the player's own volume. */
  readonly volume?: number;
  /** Length of the fade from the track before, in milliseconds. */
  readonly fadeMs?: number;
};

export type UiSlotValue =
  | StageBackdropModel
  | StageCastModel
  | StageDialogueModel
  | StageChoicesModel
  | CharacterVisualModel
  | CharacterVisualCollectionModel
  | SessionSummaryModel
  | StageMusicModel
  | null;

export type UiSlotProjectionInput = {
  readonly slot: UiSlotName;
  readonly key?: string;
  readonly previous: UiSlotValue;
  readonly events: {
    readonly topic: string;
    readonly data: Record<string, unknown>;
    readonly turnId: string;
    readonly pluginId?: string;
  }[];
};

// ── Provider context ─────────────────────────────────────────────

export type ExtensionServiceDescriptor = {
  readonly pluginId: string;
  readonly name: string;
  readonly contract: string;
  readonly description?: string;
};

/** Discover and invoke services other plugins published. */
export interface ExtensionServiceClient {
  discover(contract: string): Promise<readonly ExtensionServiceDescriptor[]>;
  call(
    request: {
      readonly pluginId: string;
      readonly name: string;
      readonly contract: string;
      readonly input: unknown;
    },
    options?: {
      readonly signal?: AbortSignal;
      readonly timeoutMs?: number;
    },
  ): Promise<unknown>;
}

export type ExtensionWorldRecord = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly lore?: string;
  readonly tags?: readonly string[];
  readonly locale?: string;
  readonly dimensions?: ExtensionWorldDimensions;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt?: string;
};

export type ExtensionAttributeDefinition = {
  readonly id: string;
  readonly name: I18nText;
  readonly type:
    "string" | "number" | "boolean" | "enum" | "array" | "object" | "map";
  readonly min?: number;
  readonly max?: number;
  readonly defaultValue?: unknown;
  readonly itemType?: "string" | "number";
  readonly options?: readonly string[];
  readonly subSchema?: readonly ExtensionAttributeDefinition[];
  readonly valueType?: "string" | "number" | "boolean";
  readonly category: "stats" | "bio" | "abilities" | "equipment" | "social";
  readonly description?: I18nText;
};

export type ExtensionCharacterSchema = {
  readonly version: number;
  readonly types: readonly string[];
  readonly attributes: readonly ExtensionAttributeDefinition[];
  readonly sessionId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type ExtensionWorldCharacter = {
  readonly id: string;
  readonly sessionId: string;
  readonly name: string;
  readonly type: string;
  readonly description?: string;
  readonly fields?: unknown;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
};

/** Read-only World Model view bound to the executing session. */
export type ExtensionWorldModel = {
  readonly worldRecord?: ExtensionWorldRecord | null;
  readonly characterSchema: ExtensionCharacterSchema | null;
  readonly characters: readonly ExtensionWorldCharacter[];
  readonly dimensions: ExtensionDimensionSnapshot;
  readonly dimensionProviderPluginId?: string;
};

/**
 * Context handed to an extension provider. Service capabilities are shared
 * with registered services; extension-specific reads are bound to this call.
 */
export interface ExtensionHandlerContext extends PluginServiceContext {
  readonly services: ExtensionServiceClient;
  readonly world: ExtensionWorldModel;
  readonly sessionId: string;
  readonly locale: string;
  /** This plugin's translations, read by `translate` and `labelText`. */
  readonly messages?: PluginMessages;
  readonly turnId?: string;
  /**
   * Read-only, own-plugin data snapshot for this execution; `get` and `list`
   * return fresh copies shaped as in a function handler.
   */
  readonly pluginData: PluginDataReader;
}

// ── provideExtension ─────────────────────────────────────────────

export type ExtensionPointHandler<P extends ExtensionPointId> = (
  input: ExtensionPointIo[P]["input"],
  context: ExtensionHandlerContext,
) => ExtensionPointIo[P]["output"] | Promise<ExtensionPointIo[P]["output"]>;

export type PluginExtensionDefinition<P extends ExtensionPointId> = {
  readonly handler: ExtensionPointHandler<P>;
};

/**
 * Extension surface of the public Plugin API. The complete entry factory
 * facade is exported as `PluginAPI` from `./plugin-api.js` and the package root.
 */
export interface PluginExtensionApi {
  /** Implement a kernel-owned point declared by this plugin's manifest. */
  provideExtension<P extends ExtensionPointId>(
    point: P,
    id: string,
    definition: PluginExtensionDefinition<P>,
  ): void;
}

export type { JsonValue };
export type {
  ExtensionWorldDimensions,
  ExtensionWorldI18nText,
  ExtensionDimensionValueSchema,
  ExtensionDimensionDefinition,
  ExtensionDimensionSnapshot,
  ExtensionDimensionSnapshotEntry,
} from "./world-dimensions.js";
