/**
 * Context assembly types.
 */

import type {
  LLMContentPart,
  RuntimeManifest,
  RuntimeResult,
  TurnInput,
  InputSlot,
  RuntimeActivation,
} from "@covel/shared";
import type { SessionContextStore } from "./session-context-store.js";
import type { BudgetOptions, TokenEstimator } from "./budget.js";

/**
 * A single LLM message in the conversation.
 *
 * `content` is a string except for the message that shows the model recent
 * pictures: that one is an array of text and `media` parts (see
 * `buildRecentPicturesMessage`).
 */
export interface LLMMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | readonly LLMContentPart[];
  readonly name?: string;
  readonly toolCallId?: string;
}

/** The assembled context ready for LLM execution. */
export interface AssembledContext {
  /** Full system prompt (PLUGIN.md body + injected data). */
  readonly systemPrompt: string;
  /**
   * The framework's own opening of `systemPrompt`: the runtime frame, the
   * output-language directive and the completion contract, with its cache
   * marker. Empty when the prompt has none. A context hook may rewrite the
   * rest of the prompt; this part stays.
   */
  readonly frameworkHead: string;
  /** Conversation messages (history + current user message). */
  readonly messages: readonly LLMMessage[];
  /**
   * Content of the turn context message in `messages`: this turn's data and
   * turn-volatile segments, placed between the history and the current turn.
   * Empty when there is none. It is fixed overhead of the request, like
   * `systemPrompt`.
   */
  readonly turnContext: string;
  /**
   * User-role messages the current turn ends the base messages with: the
   * player message, and the cue that closes this turn's story when there is
   * one. A budget pass must keep all of them.
   */
  readonly currentTurnUserMessages: number;
  /**
   * Messages the budget pass dropped to fit the slot's input window (0 when
   * nothing was pruned). Absent when no budget was configured.
   */
  readonly prunedMessageCount?: number;
}

/** Message record from the store (minimal shape needed by context builder). */
export interface MessageHistoryRecord {
  readonly role: string;
  readonly content: string;
  readonly name?: string;
  /**
   * Set by the compactor when this message has been summarized.
   * The value is the `SessionSummaryRecord.id` of the summary that replaced
   * this span. The prompt-build path substitutes the summary when a matching
   * summary record is provided.
   */
  readonly compactedAtTurnId?: string;
  /**
   * Blocks the row showed the player (`TurnMessageRecord.ui`). The row of a
   * picture carries its `asset.generate` block here; `content` is the note
   * that tells every model about it.
   */
  readonly ui?: unknown;
}

/**
 * Minimal summary record shape consumed by the context builder.
 * Matches `SessionSummaryRecord` from `@covel/store` but is
 * kept separate so `@covel/context` stays free of a store dep.
 */
export interface SummaryRecord {
  readonly id: string;
  readonly content: string;
  readonly focusSections: readonly string[];
}

/** Summary of a character record for template injection. */
export interface CharacterSummary {
  readonly id?: string;
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly type: string;
  readonly description?: string;
  readonly fields?: Record<string, unknown>;
}

/** Session-level metadata exposed to plugin templates. */
export interface SessionMeta {
  readonly turnNumber: number;
  readonly characters: readonly CharacterSummary[];
  /**
   * Latest player form submission for this session. Populated from the
   * `player_inputs` table — the newest row by time wins. Plugins read this via
   * `{{ player.lastFormValues }}` to process form submissions without
   * server-side magic.
   */
  readonly lastFormValues?: Readonly<Record<string, unknown>>;
}

/**
 * How a runtime finishes: by calling `runtime-done`, by a successful call to
 * one of its completing tools, by its structured JSON output, or, for a story
 * runtime, by the text of its reply.
 */
export type FrameworkCompletion =
  "runtime-done" | "completing-tool" | "structured-output" | "story";

/** How a runtime finishes, with what its `[COMPLETION]` instruction names. */
export interface FrameworkCompletionContract {
  /**
   * How this runtime finishes; `runtime-done` when omitted.
   *
   * Only a runtime that is given the `runtime-done` tool is told to call
   * it. A schema-declared runtime does not get that tool:
   * `buildToolDefinitions` withholds it so the early-exit branch cannot
   * fire before the JSON envelope that downstream consumers read. A story
   * runtime does not get it either: its result is the text of its reply.
   * Told to "call `runtime-done` when no tool call is needed", a model
   * that follows instructions to the letter ended the narrator's run with
   * that call and wrote no story, three times in a row, and the turn was
   * not committed.
   */
  readonly completion?: FrameworkCompletion;
  /** Tools whose successful call ends the run. Named by `completing-tool`. */
  readonly completingTools?: readonly string[];
  /**
   * The run must record its result with a business tool: `runtime-done`
   * alone does not finish it. Read by `runtime-done`.
   */
  readonly requireToolUse?: boolean;
}

/** Parameters for building an execution context. */
export interface ContextBuildParams {
  readonly promptSegments?: readonly import("@covel/shared").PromptSegment[];
  /** Runtime's prompt template. */
  readonly promptTemplate: string;
  /** Runtime's manifest. */
  readonly manifest: RuntimeManifest;
  /** Current turn input. */
  readonly turnInput: TurnInput;
  /** Completed results from other runtimes (for inject). */
  readonly completedResults: ReadonlyMap<string, RuntimeResult>;
  /** Previous turn messages (append-only history from DataStore). */
  readonly messageHistory?: readonly MessageHistoryRecord[];
  /**
   * Story text the running execution produced before this runtime. It is not
   * in `messageHistory` until the execution commits, so it is placed after the
   * current player message, where the next turn's history will show it, and
   * closed by a user-role cue.
   */
  readonly executionStory?: readonly MessageHistoryRecord[];
  /**
   * How many of the newest pictures in `messageHistory` to show the model as
   * images, in one message at the start of the current turn. The caller sets
   * it only for a model that accepts image input; 0 or absent sends none.
   */
  readonly pictureAttachments?: number;
  /** Session-level metadata (turnNumber, characters, lastFormValues). */
  readonly sessionMeta?: SessionMeta;
  /**
   * Token estimator injected by the caller for budget calculation. Optional.
   * When both this and {@link ContextBuildParams.contextBudget} are set, the
   * builder runs a pruning pass before returning the assembled context.
   */
  readonly estimator?: TokenEstimator;
  /**
   * Budget config. If present together with `estimator`, message pruning runs.
   * The `estimator` field of `BudgetOptions` is supplied via
   * {@link ContextBuildParams.estimator}, so callers need only provide the
   * numeric limits here.
   */
  readonly contextBudget?: Omit<BudgetOptions, "estimator">;
  /**
   * Caller override for segment 1 (framework preamble). When omitted, the
   * builder derives a minimal locale-based preamble.
   */
  readonly frameworkPreamble?: string;
  /**
   * Session summaries generated by the compactor.
   * When provided, the prompt-build path substitutes compacted message spans
   * with their summary.
   * The caller (turn-executor) is responsible for loading these from the store.
   */
  readonly summaries?: readonly SummaryRecord[];
  /**
   * Data store handle used by the async build path to resolve
   * `input.inject` entries of kind `plugin-data`. Only consulted when a
   * plugin-data inject is present in the manifest.
   *
   * Typed against the narrow {@link SessionContextStore} surface so
   * `@covel/context` does not depend on `@covel/store`. The concrete
   * `DataStore` from `@covel/store` satisfies this shape via structural typing.
   */
  readonly store?: SessionContextStore;
  /** Pre-assembled committed session context. */
  readonly sessionContext?: SessionContextSnapshot;
  /**
   * Player-authored settings for *this* runtime's plugin, already merged with
   * the manifest's `userSettings[].default` values (see `resolveUserSettings`
   * in `@covel/runtime`). Exposed to agent prompts as `{{ userSettings.<key> }}`
   * so templates can branch on player choices (e.g. promptMode, model preset)
   * without needing a guard handler. Function runtimes receive the same bucket
   * via `ctx.userSettings`. Undefined when the manifest declares no
   * `userSettings` specs — template lookups resolve to empty strings then.
   */
  readonly userSettings?: Readonly<Record<string, unknown>>;
  /**
   * Rendered text of the session's advertised event directory (topics +
   * localized descriptions + required fields), produced by the server's
   * event-directory service. Only injected into segment 5 when the
   * runtime's manifest also declares `advertiseEvents: true` — see
   * {@link RuntimeManifest.advertiseEvents}. Absent or empty string → no
   * `<available-events>` block is rendered.
   */
  readonly eventCatalogText?: string;
  /**
   * Resolved same-execution input bindings (`inputs.<name>`), provenance-
   * wrapped. Rendered into segment 5 as a framework-only `<runtime-inputs>`
   * block (JSON shape identical to function `ctx.inputs`) so an agent runtime
   * sees the same bound values a function handler would. Absent → no block.
   */
  readonly inputSlots?: Readonly<Record<string, InputSlot>>;
  /**
   * Resolved cross-execution `recordAs` exports (`input.inject` runtime-export),
   * provenance-wrapped. Rendered into segment 5 as a framework-only
   * `<runtime-exports>` block (same JSON shape as function `ctx.exports`) so an
   * agent runtime reads the same frozen export values a function handler would
   * (docs 02 §3.4.3). Absent → no block.
   */
  readonly exportSlots?: Readonly<Record<string, InputSlot>>;
  /**
   * Canonical activation for this run. Rendered into segment 5 as the reserved
   * `<runtime-activation>` block (`{ source, detached, payload }` JSON) that a
   * plugin template cannot override or omit (docs 02 §3.3). Absent → no block.
   */
  readonly activation?: RuntimeActivation;
}

// ── Session Context Snapshot ─────────────────────────────────────
//
// Shared vocabulary for per-turn world, memory, summary, and contribution data.

/** Structured world data exposed to plugin templates as `{{ world.* }}`. */
export interface WorldContextView {
  readonly id: string;
  /** Short display name suitable for stable prompt headers. */
  readonly name?: string;
  /** Concise world summary; prefer this over embedding the full lore each turn. */
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly lore?: string;
  readonly dimensions?: import("@covel/shared").DimensionSnapshot;
  readonly dimensionProviderPluginId?: string;
  readonly schema?: Readonly<Record<string, unknown>>;
  readonly entries?: readonly Readonly<Record<string, unknown>>[];
  /** Free-form extra fields from world metadata. */
  readonly extra?: Readonly<Record<string, unknown>>;
}

/**
 * Minimal view over a lorebook entry, mirroring the store's
 * `LorebookEntryRecord` but kept decoupled so `@covel/context` does not leak
 * DB record types into its consumers (same pattern as {@link SummaryRecord}).
 */
export interface LorebookEntryView {
  readonly id: string;
  readonly owner: import("@covel/shared").LorebookOwner;
  readonly content: string;
  readonly keys?: readonly string[];
  readonly enabled?: boolean;
  /** Free-form extra carried verbatim from the stored record (strategy, position, timestamps, …). */
  readonly extra?: Readonly<Record<string, unknown>>;
}

/**
 * Lorebook-side prompt position: lore renders before the PLUGIN.md segment,
 * after it, or injected at a specific depth in the message history.
 */
export type LorebookPromptPosition =
  "before_plugin" | "after_plugin" | "at_depth";

/**
 * Every prompt position a {@link ContextContribution} may target — the union
 * of the persona-side and lorebook-side positions. Single named type shared
 * by the snapshot loader, the contribution aggregator, and the assembler.
 */
export type PromptPosition = LorebookPromptPosition;

/**
 * The central session-level context snapshot.
 *
 * A loader (`buildSessionContextSnapshot`) collapses the scattered DB reads in
 * `turn-executor.ts` into a single call and compiles the persona / lorebook
 * {@link ContextContribution} stream consumed by the prompt assembler.
 *
 * Kept strictly `readonly` — the snapshot is meant to be built once per
 * turn and threaded through without mutation.
 */
export interface SessionContextSnapshot {
  readonly sessionId: string;
  readonly turnNumber: number;
  readonly locale: string;
  readonly sessionMeta: SessionMeta;
  readonly world: WorldContextView;
  readonly characters: readonly CharacterSummary[];
  readonly loreEntries: readonly LorebookEntryView[];
  readonly summaries: readonly SummaryRecord[];
  /** Compiled persona / lorebook contribution stream consumed by the assembler. */
  readonly contributions: readonly ContextContribution[];
}

/**
 * Discriminator for a single {@link ContextContribution}. The two kinds the
 * loader actually compiles — lorebook world rules and the player persona
 * description — each map to a segment position in the assembled prompt.
 */
export type ContributionKind = "lore_entry"; // lorebook world rules (before/after plugin, or at-depth)

/**
 * A single piece of prompt content with provenance, a coordinate, and a debug
 * trace bag. The prompt assembler consumes a stream of these (persona / lore)
 * to build the final layered prompt.
 *
 * Field coupling:
 * - `depth` is only meaningful when `position === 'at_depth'`. For all other
 *   `position` values the assembler ignores `depth`.
 * - `order` is used as insertion-order within the same `(position, depth)`
 *   slot — lower numbers render first; equal `order` keeps source order.
 */
export interface ContextContribution {
  readonly kind: ContributionKind;
  readonly sourceType: "world";
  /** personaId (persona) / lorebook entry id (world). */
  readonly sourceId: string;
  readonly content: string;
  readonly position?: PromptPosition;
  readonly depth?: number;
  /** insertionOrder synonym. */
  readonly order?: number;
  readonly role?: "system" | "user" | "assistant";
  /**
   * Free-form debug trace bag. The shape is intentionally loose so producers
   * can attach arbitrary provenance without schema churn. Lorebook
   * contributions attach `pluginId`, `strategy`, `keys`, and (when present)
   * `sourceRuleId`.
   */
  readonly debugTrace?: Readonly<Record<string, unknown>>;
}
