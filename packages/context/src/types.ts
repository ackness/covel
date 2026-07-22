/**
 * Context assembly types.
 */

import type {
  ContentPart,
  I18nText,
  RuntimeManifest,
  RuntimeResult,
  TurnInput,
  InputSlot,
  RuntimeActivation,
} from "@covel/shared";
import type { SessionContextStore } from "./session-context-store.js";
import type { BudgetOptions, TokenEstimator } from "./budget.js";

/** Re-export for callers that consume {@link LLMMessage}. */
export type { ContentPart } from "@covel/shared";

/**
 * A single LLM message in the conversation.
 *
 * `content` is `string` for the historical text-only path. When a message
 * carries multimodal data (e.g. a generated image referenced from history)
 * the bridge in `buildMessageHistoryWithSummaries` rewrites the field to a
 * `readonly ContentPart[]`. Downstream adapters in `@covel/ai-provider`
 * accept the same union via their `TextMessageContent` shape, so the value
 * passes through without conversion.
 */
export interface LLMMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | readonly ContentPart[];
  readonly name?: string;
  readonly toolCallId?: string;
}

/** The assembled context ready for LLM execution. */
export interface AssembledContext {
  /** Full system prompt (PLUGIN.md body + injected data). */
  readonly systemPrompt: string;
  /** Conversation messages (history + current user message). */
  readonly messages: readonly LLMMessage[];
  /**
   * Set when the budget pass had to drop history to fit the slot's input
   * window. Callers surface it as a trace signal so a turn that silently lost
   * context is visible in /debug. Absent when no budget was configured.
   */
  readonly budgetExceeded?: boolean;
  /** Messages dropped by the budget pass (0 when nothing was pruned). */
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
   * Optional free-form bag mirroring the `metadata` payload that
   * `commit*` handlers in `@covel/runtime` write to wire-format
   * messages. The context-builder bridge inspects
   * `metadata.block.type === 'asset.generate'` to upgrade plain text
   * history entries into multimodal {@link ContentPart} arrays so a
   * vision-capable runtime can reason over previously generated assets.
   *
   * The shape is intentionally `unknown` — the bridge narrows defensively
   * and falls back to the plain-string path when fields are missing or
   * mistyped, so callers that do not know about block metadata keep the same
   * text-only behaviour.
   */
  readonly metadata?: unknown;
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
  readonly name: string;
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
   * `player_inputs` table — the most recent row wins. Plugins read this via
   * `{{ player.lastFormValues }}` to process form submissions without
   * server-side magic.
   */
  readonly lastFormValues?: Readonly<Record<string, unknown>>;
}

/** A single Working Memory entry (minimal shape for context injection). */
export interface WorkingMemoryEntry {
  readonly scope: "player" | "story" | "shared";
  readonly key: string;
  readonly value: unknown;
}

/** Parameters for building an execution context. */
export interface ContextBuildParams {
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
  /** Session-level metadata (turnNumber, characters, lastFormValues). */
  readonly sessionMeta?: SessionMeta;
  /** Working memory entries. When absent or empty, no segment is rendered. */
  readonly workingMemory?: readonly WorkingMemoryEntry[];
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
   * Manifests whose `authorsNote` / `postHistory` feed segments 9 and 10.
   *
   * The builder merges every declaration it finds here in `priority` order
   * (ascending, so earlier priorities render first). When omitted it falls
   * back to `[params.manifest]`.
   *
   * The turn executor deliberately passes ONLY the executing runtime's own
   * (locale-resolved) manifest, not the session's whole active set.
   * `postHistory` is a runtime's private working instruction — its tool
   * workflow, its termination contract — so aggregating across plugins would
   * put one plugin's internal directives into another plugin's system prompt.
   * That is a plugin-isolation leak, and it also lets an unrelated plugin's
   * instructions steer a runtime whose author never opted in. The parameter
   * stays plural because the builder is generic and a caller that genuinely
   * wants a curated multi-manifest prompt can supply one; the framework's own
   * turn path does not.
   */
  readonly activeManifests?: readonly RuntimeManifest[];
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
  /**
   * Core memory blocks (Letta-style in-context memory).
   * When present, rendered as a `[Core Memory]` section in the prompt.
   * Managed by `@covel/memory` — the context builder only consumes the data.
   */
  readonly coreMemoryBlocks?: readonly {
    readonly label: string;
    readonly content: string;
    /**
     * Localized display name, attached by `@covel/memory`'s manager from the
     * active block schema. Used by the prompt renderer for the block heading;
     * falls back to the raw label when absent.
     */
    readonly displayName?: I18nText;
  }[];
  /**
   * Pre-assembled session context. When provided, prompt assembly reads
   * session-level data from here instead of the scattered `sessionMeta` /
   * `workingMemory` / `coreMemoryBlocks` fields.
   */
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
  readonly lore?: string;
  readonly tone?: string;
  readonly openingScenario?: string;
  readonly dimensions?: Readonly<Record<string, unknown>>;
  readonly schema?: Readonly<Record<string, unknown>>;
  readonly entries?: readonly Readonly<Record<string, unknown>>[];
  /** Free-form extra fields from world metadata. */
  readonly extra?: Readonly<Record<string, unknown>>;
}

/**
 * Captures the content of a Core Memory block (Letta-style in-context memory).
 *
 * Named counterpart to the inline anonymous shape already used on
 * {@link ContextBuildParams.coreMemoryBlocks}. A dedicated type exists
 * because `@covel/context` intentionally does not depend on `@covel/memory`
 * (see `packages/context/package.json`), so we cannot reuse
 * `@covel/memory`'s `CoreMemoryBlock` directly.
 */
export interface CoreMemoryBlockView {
  readonly label: string;
  readonly content: string;
  readonly updatedAt?: string;
  /**
   * Localized display name, attached by `@covel/memory`'s manager from the
   * active block schema. Lets the prompt renderer and panels show a friendly
   * heading without `@covel/context` depending on `@covel/memory`.
   */
  readonly displayName?: I18nText;
}

/**
 * Minimal view over a lorebook entry, mirroring the store's
 * `LorebookEntryRecord` but kept decoupled so `@covel/context` does not leak
 * DB record types into its consumers (same pattern as {@link SummaryRecord}).
 */
export interface LorebookEntryView {
  readonly id: string;
  readonly pluginId: string;
  readonly content: string;
  readonly keys?: readonly string[];
  readonly enabled?: boolean;
  /** Free-form extra carried verbatim from the stored record (strategy, position, timestamps, …). */
  readonly extra?: Readonly<Record<string, unknown>>;
}

/**
 * Player persona descriptor.
 *
 * Loaded by `buildSessionContextSnapshot` from the persona-provider plugin's
 * `session-binding` / `profiles` namespaces (see `loadActivePersona`) and
 * compiled into a `persona_description` {@link ContextContribution} that the
 * prompt assembler renders into the system prompt.
 */
export interface PersonaProfile {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  /**
   * Optional coordinate hint for how the description injects.
   *
   * Field coupling:
   * - `depth` is only meaningful when `position === 'at_depth'`. For
   *   `'seg3_prepend'` and `'seg3_append'`, the assembler ignores `depth`.
   * - `order` controls ordering when multiple contributions target the same
   *   `(position, depth)` slot — lower numbers render first.
   */
  readonly promptCoordinate?: {
    readonly position: "seg3_prepend" | "seg3_append" | "at_depth";
    readonly depth?: number;
    readonly order?: number;
  };
}

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
  /** Loaded from the persona-provider plugin; undefined when none is active. */
  readonly activePersona?: PersonaProfile;
  readonly workingMemory: readonly WorkingMemoryEntry[];
  readonly coreMemoryBlocks: readonly CoreMemoryBlockView[];
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
export type ContributionKind =
  | "lore_entry" // lorebook world rules (before/after plugin, or at-depth)
  | "persona_description"; // player persona injection (seg-3 prepend/append, or at-depth)

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
  readonly sourceType: "persona" | "world";
  /** personaId (persona) / lorebook entry id (world). */
  readonly sourceId: string;
  readonly content: string;
  readonly position?:
    | "before_plugin"
    | "after_plugin"
    | "at_depth"
    | "seg3_prepend"
    | "seg3_append";
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
