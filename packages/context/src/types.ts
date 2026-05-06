/**
 * Context assembly types.
 */

import type {
	ContentPart,
	RuntimeManifest,
	RuntimeResult,
	TurnInput,
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
}

/** Message record from the store (minimal shape needed by context builder). */
export interface MessageHistoryRecord {
	readonly role: string;
	readonly content: string;
	readonly name?: string;
	/**
	 * Set by the compactor (S2-T2) when this message has been summarized.
	 * The value is the `SessionSummaryRecord.id` of the summary that replaced
	 * this span. The prompt-build path substitutes the summary when the flag
	 * `COVEL_COMPACTOR_V1=1` is set.
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
	 * mistyped, so callers that do not know about block metadata stay
	 * byte-identical to the legacy behaviour.
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
	/** Runtime's effective config values. */
	readonly config: Readonly<Record<string, unknown>>;
	/** Previous turn messages (append-only history from DataStore). */
	readonly messageHistory?: readonly MessageHistoryRecord[];
	/** Session-level metadata (turnNumber, characters, lastFormValues). */
	readonly sessionMeta?: SessionMeta;
	/**
	 * Working memory entries (S3-T3). Populated when COVEL_WORKING_MEMORY_V1=1.
	 * When absent or empty, no [Working Memory] segment is rendered.
	 */
	readonly workingMemory?: readonly WorkingMemoryEntry[];
	/**
	 * Token estimator injected by the caller for budget calculation. Optional.
	 * When both this and {@link ContextBuildParams.contextBudget} are set and
	 * `COVEL_CONTEXT_BUDGET_V1=1` is in the environment, the builder runs a
	 * pruning pass before returning the assembled context.
	 */
	readonly estimator?: TokenEstimator;
	/**
	 * Budget config. If present together with `estimator` and the feature
	 * flag, message pruning runs. The `estimator` field of `BudgetOptions`
	 * is supplied via {@link ContextBuildParams.estimator}, so callers need
	 * only provide the numeric limits here.
	 */
	readonly contextBudget?: Omit<BudgetOptions, "estimator">;
	/**
	 * V2 (three-tier prompt assembler) only — caller override for segment 1
	 * (framework preamble). When omitted, V2 derives a minimal locale-based
	 * preamble. V1 ignores this field. Introduced in S2-T1.
	 */
	readonly frameworkPreamble?: string;
	/**
	 * Session summaries (S2-T2 Compactor).
	 * When provided AND `COVEL_COMPACTOR_V1=1` is set, the prompt-build path
	 * substitutes compacted message spans with their summary.
	 * The caller (turn-executor) is responsible for loading these from the store.
	 */
	readonly summaries?: readonly SummaryRecord[];
	/**
	 * Active runtime manifests considered for segment-9/10 aggregation (S3-T4).
	 *
	 * V2 scans these manifests for their `authorsNote` and `postHistory` fields
	 * and merges all declarations into the final prompt in `priority` order
	 * (ascending, so earlier priorities render first). When omitted, V2 falls
	 * back to `[params.manifest]` so a runtime's own notes still apply.
	 *
	 * V1 ignores this field. Only exercised under `COVEL_PROMPT_V2=1`.
	 */
	readonly activeManifests?: readonly RuntimeManifest[];
	/**
	 * Data store handle used by the async build path to resolve
	 * `input.inject` entries of kind `plugin-data`. Only consulted when a
	 * plugin-data inject is present in the manifest. The sync `buildContext`
	 * path ignores this field entirely and stays byte-identical to the
	 * pre-ticket behaviour.
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
	}[];
	/**
	 * Pre-assembled session context (Sprint 1). When provided, prompt assembly
	 * reads session-level data from here instead of the legacy scattered
	 * `config` / `sessionMeta` / `workingMemory` / `coreMemoryBlocks` fields.
	 * Gated by the `COVEL_SESSION_CONTEXT` flag at the caller layer (Sprint 1-D).
	 *
	 * Both channels coexist through Sprint 1 and 2 as a safety net. Sprint 2 end
	 * removes the legacy channel and this field becomes required.
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
}

// ── Session Context Snapshot (Sprint 1) ──────────────────────────
//
// New shared vocabulary introduced by the SillyTavern alignment refactor.
// Sprint 1-A only defines the types — no runtime is wired up yet.
// Sprint 1-D gates consumption via the `COVEL_SESSION_CONTEXT` flag.

/**
 * Structured view over the world data the legacy flat `config.world*` shape
 * carried. Derived from what `loadSessionConfig`
 * (`apps/server/src/routes/api/load-session-config.ts`) produces today.
 *
 * Consumers should read via the named fields; unknown keys survive through
 * `extra` for forward compatibility until Sprint 2 formalises the schema.
 */
export interface WorldContextView {
	readonly id: string;
	readonly lore?: string;
	readonly tone?: string;
	readonly openingScenario?: string;
	readonly dimensions?: Readonly<Record<string, unknown>>;
	readonly schema?: Readonly<Record<string, unknown>>;
	readonly entries?: readonly Readonly<Record<string, unknown>>[];
	/** Free-form extra fields (forward-compat; consumers may read via bracket access). */
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
}

/**
 * Minimal view over a lorebook entry, mirroring the store's
 * `LorebookEntryRecord` but kept decoupled so `@covel/context` does not leak
 * DB record types into its consumers (same pattern as {@link SummaryRecord}).
 *
 * Sprint 2 flesh out triggers / probability / sticky semantics via `extra`
 * or by promoting fields up to the top level.
 */
export interface LorebookEntryView {
	readonly id: string;
	readonly pluginId: string;
	readonly content: string;
	readonly keys?: readonly string[];
	readonly enabled?: boolean;
	/** Free-form extra (triggers, probability, sticky, etc. — Sprint 2 structures this). */
	readonly extra?: Readonly<Record<string, unknown>>;
}

/**
 * Player persona descriptor — *stub for Sprint 3, not wired up yet*.
 *
 * Sprint 3 introduces persona selection, description injection, and the
 * lorebook-activation bridge. Fields are minimal but forward-compatible so
 * Sprint 1-era consumers that merely plumb the snapshot through don't break
 * when Sprint 3 adds behaviour.
 */
export interface PersonaProfile {
	readonly id: string;
	readonly name: string;
	readonly description?: string;
	/**
	 * Optional coordinate hint for how the description injects.
	 * Full semantics defined in Sprint 3.
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
	/** Lorebook entry IDs this persona activates. Sprint 3 wires this. */
	readonly loreEntryIds?: readonly string[];
}

/**
 * The central session-level context snapshot the whole refactor hinges on.
 *
 * Sprint 1 introduces the type and a loader that collapses the ~6 scattered
 * DB reads in `turn-executor.ts` into a single call. Sprint 2 adds the
 * compiled {@link ContextContribution} stream; Sprint 3 wires
 * {@link PersonaProfile} and character overlays.
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
	/** Sprint 3 introduces this; undefined until then. */
	readonly activePersona?: PersonaProfile;
	readonly workingMemory: readonly WorkingMemoryEntry[];
	readonly coreMemoryBlocks: readonly CoreMemoryBlockView[];
	readonly loreEntries: readonly LorebookEntryView[];
	readonly summaries: readonly SummaryRecord[];
	/**
	 * Legacy `config` object identical to what `loadSessionConfig` produces today.
	 * Kept for template-variable compatibility until all plugin PLUGIN.md templates
	 * migrate to the structured namespaces. Sprint 3 end removes this.
	 */
	readonly legacyConfigView: Readonly<Record<string, unknown>>;
	/** Pre-compiled contribution stream (filled in Sprint 2/3; Sprint 1 returns []). */
	readonly contributions: readonly ContextContribution[];
}

/**
 * Discriminator for a single {@link ContextContribution}. Each kind maps to a
 * SillyTavern-style segment position in the assembled prompt — see the inline
 * comments for the target slice(s).
 */
export type ContributionKind =
	| "static_prompt" // plugin instructions (Seg 3)
	| "lore_entry" // lorebook (Seg 4/6/8)
	| "persona_description" // persona injection (between Seg 1–3)
	| "character_overlay" // character-level system prompt (Seg 3)
	| "authors_note" // Seg 9
	| "post_history" // Seg 10
	| "runtime_inject" // Seg 5
	| "working_memory" // Seg 2
	| "core_memory"; // Seg 2

/**
 * A single piece of prompt content with full provenance, coordinate, budget
 * hints, and a debug trace bag. The prompt assembler consumes a stream of
 * these to build the final layered prompt.
 *
 * Sprint 1 only defines the type. Sprint 2 introduces the lorebook activator
 * and plumbs these through `SessionContextSnapshot.contributions`.
 *
 * Field coupling:
 * - `depth` is only meaningful when `position === 'at_depth'` OR when
 *   `kind === 'authors_note'` (Seg 9 uses depth semantics natively). For all
 *   other `position` / `kind` combinations, the assembler ignores `depth`.
 * - `order` is used as insertion-order within the same `(position, depth)`
 *   slot — lower numbers render first; equal `order` keeps source order.
 * - `triggers` lists which generation modes activate this contribution. When
 *   `triggers` is omitted the contribution is active in all modes; when set,
 *   only the listed modes activate it.
 */
export interface ContextContribution {
	readonly kind: ContributionKind;
	readonly sourceType:
		| "manifest"
		| "character"
		| "persona"
		| "world"
		| "session"
		| "chat";
	/** pluginId / characterId / personaId / worldId / sessionId. */
	readonly sourceId: string;
	readonly content: string;
	// SillyTavern-style coordinate
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
	readonly triggers?: readonly (
		| "normal"
		| "continue"
		| "regenerate"
		| "quiet"
	)[];
	// budget hints
	readonly budgetClass?: "sticky" | "flexible" | "droppable";
	readonly reservedTokens?: number;
	/**
	 * Free-form debug trace bag. The shape is intentionally loose so producers
	 * can attach arbitrary provenance without schema churn. Sprint 2 and 3 will
	 * write at least the following keys: `activatedBy` (the matcher/keyword/rule
	 * that produced this contribution), `tokenEstimate` (pre-budget estimate),
	 * and `sourceDescription` (human-readable origin label).
	 */
	readonly debugTrace?: Readonly<Record<string, unknown>>;
}
