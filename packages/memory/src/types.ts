/**
 * @covel/memory — Three-tier memory system inspired by Letta (MemGPT).
 *
 * Memory tiers:
 *   1. Core Memory Blocks — Editable text segments inside the context window.
 *      Updated post-turn by a framework-driven LLM summarizer.
 *   2. Recall Memory — Searchable conversation history (keyword search).
 *   3. Archival Memory — Long-term cross-plugin knowledge (lorebook + characters).
 *
 * Compaction — Older messages are summarized and replaced in prompts.
 *   Core memory blocks are updated simultaneously so key information survives.
 */

import type {
  I18nText,
  MemoryBlockSchema,
  SimpleCompletionAdapter,
} from "@covel/shared";
import type { DataStore } from "@covel/store";

// ── Core Memory Blocks ──────────────────────────────────────────

/**
 * A core-memory block label.
 *
 * **Open by design.** Labels are plain strings, not a closed union — the set
 * of blocks is driven by the {@link CoreMemoryBlockSchema} the framework is
 * configured with (declared by plugins/worlds via the `memoryBlocks` manifest
 * field). A detective game can use `clues` / `suspects` / `timeline`; the
 * kernel never hardcodes the label set.
 */
export type CoreMemoryLabel = string;

/**
 * Declarative definition of a core-memory block: its label, display name, and
 * the extraction guidance handed to the summarizer LLM. Canonical shape lives
 * in `@covel/shared` ({@link MemoryBlockSchema}); re-exported here as the
 * memory package's API vocabulary.
 */
export type CoreMemoryBlockSchema = MemoryBlockSchema;

/**
 * Generic, world-agnostic default blocks used as a fallback when no schema is
 * injected (standalone use, tests, or a boot where no plugin declared
 * `memoryBlocks`). In production the builtin `memory` plugin declares the
 * authoritative copy and the server injects it — see
 * `apps/server/src/routes/api/bootstrap/memory.ts`. Kept de-coupled from any
 * specific world: no genre- or setting-specific vocabulary belongs here.
 */
export const DEFAULT_CORE_MEMORY_BLOCKS: readonly CoreMemoryBlockSchema[] = [
  {
    label: "story_state",
    displayName: { zh: "剧情状态", en: "Story State" },
    icon: "BookOpen",
    extractionHint: {
      zh: "主线剧情摘要、已揭示的秘密、未解决的悬念、已完成的关键事件。",
      en: "Main plot summary, revealed secrets, unresolved threads, key completed events.",
    },
  },
  {
    label: "character_relationships",
    displayName: { zh: "角色关系", en: "Character Relationships" },
    icon: "Users",
    extractionHint: {
      zh: "关键角色与玩家之间的关系状态、态度变化、重要互动与承诺。",
      en: "Key characters' relationships with the player, attitude shifts, important interactions and commitments.",
    },
  },
  {
    label: "scene",
    displayName: { zh: "当前场景", en: "Current Scene" },
    icon: "MapPin",
    extractionHint: {
      zh: "当前所在位置、时间、氛围与环境描写要点。",
      en: "Current location, time, atmosphere, and salient environmental details.",
    },
  },
  {
    label: "player_profile",
    displayName: { zh: "玩家状态", en: "Player Profile" },
    icon: "User",
    extractionHint: {
      zh: "玩家角色的当前状态摘要：能力、所持之物、处境与当前目标。",
      en: "Player character status summary: abilities, possessions, situation, and current objectives.",
    },
  },
];

/**
 * Display metadata for a core memory label, consumed by UI layers that prefer
 * a flat `{ displayName, icon }` lookup. Icons use Lucide icon names.
 */
export interface CoreMemoryLabelInfo {
  readonly displayName: I18nText;
  readonly icon: string;
}

/** Ordered list of the default block labels. Derived — single source of truth. */
export const CORE_MEMORY_LABELS: readonly CoreMemoryLabel[] =
  DEFAULT_CORE_MEMORY_BLOCKS.map((b) => b.label);

/**
 * Flat display registry for the default blocks. Derived from
 * {@link DEFAULT_CORE_MEMORY_BLOCKS} so display names live in exactly one
 * place. UI/back-compat consumers read this; the runtime path reads the
 * injected schema instead.
 */
export const CORE_MEMORY_LABEL_INFO: Readonly<
  Record<string, CoreMemoryLabelInfo>
> = Object.fromEntries(
  DEFAULT_CORE_MEMORY_BLOCKS.map((b) => [
    b.label,
    { displayName: b.displayName, icon: b.icon ?? "Info" },
  ]),
);

/** Default max characters per block (not tokens — char count is cheaper to check). */
export const DEFAULT_MAX_BLOCK_CHARS = 2000;

export interface CoreMemoryBlock {
  readonly label: CoreMemoryLabel;
  readonly content: string;
  readonly updatedAt: string;
  /**
   * Localized display name for this block, resolved from the active block
   * schema by the manager. Rides along with the block so the prompt renderer
   * and UI panels need not re-derive it (`@covel/context` cannot depend on
   * `@covel/memory`). Optional: absent for blocks outside the active schema.
   */
  readonly displayName?: I18nText;
  /** Lucide icon name for this block, resolved from the active block schema. */
  readonly icon?: string;
}

export interface CoreMemoryConfig {
  /** Max characters per block. Default: 2000. */
  readonly maxBlockChars?: number;
  /**
   * Block schema this manager governs — labels, display names, icons, and
   * per-block char caps. Defaults to {@link DEFAULT_CORE_MEMORY_BLOCKS}.
   * Injected by the bootstrap layer from aggregated plugin `memoryBlocks`.
   */
  readonly blocks?: readonly CoreMemoryBlockSchema[];
  /**
   * Per-session block schema resolver. When provided, methods resolve the
   * schema for a given `sessionId` (e.g. plugin blocks merged with the
   * session's world-declared blocks) instead of using the static `blocks`.
   * Returning undefined falls back to `blocks`. Injected by the bootstrap layer.
   */
  readonly resolveBlocks?: (
    sessionId: string,
  ) => Promise<readonly CoreMemoryBlockSchema[] | undefined>;
  /**
   * Plugin ID used when mirroring core memory blocks to plugin_data for
   * real-time UI panel updates. Injected by the bootstrap layer so the
   * memory package never hardcodes a specific plugin name.
   */
  readonly pluginId?: string;
}

// ── Memory Manager ──────────────────────────────────────────────

export interface MemoryManager {
  /** Load all core memory blocks for a session. Returns empty blocks if not initialized. */
  loadBlocks(sessionId: string): Promise<readonly CoreMemoryBlock[]>;

  /** Read a single block. Returns null if not found. */
  getBlock(
    sessionId: string,
    label: CoreMemoryLabel,
  ): Promise<CoreMemoryBlock | null>;

  /** Write (create or overwrite) a single block. */
  updateBlock(
    sessionId: string,
    label: CoreMemoryLabel,
    content: string,
  ): Promise<void>;

  /** Batch-write multiple blocks atomically. */
  updateBlocks(
    sessionId: string,
    updates: ReadonlyMap<CoreMemoryLabel, string>,
  ): Promise<void>;

  /** Create empty blocks for all configured labels. Idempotent. */
  initializeDefaults(sessionId: string): Promise<void>;
}

// ── Memory Updater (post-turn LLM-driven refresh) ───────────────

/**
 * Minimal LLM adapter for the memory updater/compactor. Aliased to the shared
 * {@link SimpleCompletionAdapter} (single source of truth in `@covel/shared`)
 * with the default `"user" | "assistant"` role union, since the core-memory
 * layer models both player and assistant turns. Re-exported under this name
 * for backward compatibility.
 */
export type MemoryLLMAdapter = SimpleCompletionAdapter;

export interface MemoryUpdaterConfig {
  /** Model slot name for the summarizer. Resolution: memory → story. */
  readonly modelSlot?: string;
  /** Locale for the updater prompt. Default: zh-CN. */
  readonly locale?: string;
  /**
   * Block schema driving the extraction prompt and label validation. The
   * summarizer's system prompt is assembled from each block's
   * `extractionHint`; only these labels are accepted in the LLM response.
   * Defaults to {@link DEFAULT_CORE_MEMORY_BLOCKS}.
   */
  readonly blocks?: readonly CoreMemoryBlockSchema[];
  /**
   * Per-session block schema resolver (see {@link CoreMemoryConfig.resolveBlocks}).
   * When provided, the updater builds its extraction prompt from the resolved
   * schema for the turn's session. Returning undefined falls back to `blocks`.
   */
  readonly resolveBlocks?: (
    sessionId: string,
  ) => Promise<readonly CoreMemoryBlockSchema[] | undefined>;
}

export interface MemoryUpdateResult {
  readonly updated: boolean;
  readonly blocksChanged: readonly CoreMemoryLabel[];
  readonly error?: string;
}

export interface MemoryUpdater {
  /**
   * Analyze completed turn results and update core memory blocks.
   * Uses a cheap LLM call to extract key information.
   *
   * Callers typically fire-and-forget this at turn end, but the updater
   * internally tracks the in-flight promise per session. Use
   * {@link MemoryUpdater.awaitPending} at the start of the next turn to
   * guarantee the next prompt sees the freshest blocks — critical when
   * the player submits two messages back-to-back and the LLM call from
   * the previous turn has not yet finished persisting.
   */
  updateAfterTurn(params: {
    sessionId: string;
    narrativeText: string;
    toolCallSummaries?: readonly string[];
    currentBlocks: readonly CoreMemoryBlock[];
    locale?: string;
  }): Promise<MemoryUpdateResult>;

  /**
   * Resolve when the most recently started `updateAfterTurn` for the given
   * session has finished (success or failure). No-op when no update is
   * pending. Used by the turn executor to avoid the "next turn reads stale
   * memory blocks while previous turn's update is still writing" race.
   */
  awaitPending(sessionId: string): Promise<void>;
}

// ── Recall Memory (conversation history search) ─────────────────

export interface RecallSearchResult {
  readonly turnId: string;
  readonly role: string;
  readonly content: string;
  /**
   * Relevance score (higher = more relevant). Currently a lexical term-overlap
   * score from the keyword searcher — NOT vector similarity. A future
   * vector-backed searcher would populate this with a normalized cosine score
   * while keeping the same field contract.
   */
  readonly score: number;
  readonly timestamp: string;
}

/**
 * Conversation-history search. The active implementation is keyword-based
 * (`createKeywordRecallSearcher`); this interface is also the **extension seam**
 * for a future semantic (vector) searcher — `createMemorySystem` picks the
 * concrete implementation, so callers (tools, prompt assembly) are unaffected
 * by the swap. Vector recall additionally needs an embed-on-write ingestion
 * path (not yet built); see recall-search.ts.
 */
export interface RecallSearcher {
  search(
    sessionId: string,
    query: string,
    limit?: number,
  ): Promise<readonly RecallSearchResult[]>;
}

// ── Archival Memory (cross-plugin knowledge search) ─────────────

export interface ArchivalSearchResult {
  readonly key: string;
  readonly content: string;
  /** Lexical term-overlap score (higher = more relevant); see {@link RecallSearchResult.score}. */
  readonly score: number;
  /**
   * Origin of the matched record. `"plugin_data"` is reserved for a future
   * vector path — the current keyword searcher only emits `"lorebook"` and
   * `"character"` (see archival-search.ts).
   */
  readonly source: "plugin_data" | "lorebook" | "character";
  readonly pluginId?: string;
  readonly namespace?: string;
}

/**
 * Cross-plugin knowledge search. Keyword-based today
 * (`createKeywordArchivalSearcher`); same **extension seam** as
 * {@link RecallSearcher} for a future vector implementation.
 */
export interface ArchivalSearcher {
  search(
    sessionId: string,
    query: string,
    limit?: number,
  ): Promise<readonly ArchivalSearchResult[]>;
}

// ── Compaction ──────────────────────────────────────────────────

export interface CompactionConfig {
  /** Fraction of context window that triggers compaction. Default: 0.6. */
  readonly threshold?: number;
  /** Number of trailing user messages to protect. Default: 2. */
  readonly protectLastNUserTurns?: number;
  /** Always protect at least this many tail messages. Default: 5. */
  readonly protectLastNMessages?: number;
  /** Model slot for the summarizer. Resolution: memory → story. */
  readonly modelSlot?: string;
  readonly locale?: string;
  /**
   * Block schema forwarded to the post-compaction core-memory refresh so the
   * compactor uses the same labels/hints as the main updater. Defaults to
   * {@link DEFAULT_CORE_MEMORY_BLOCKS}.
   */
  readonly blocks?: readonly CoreMemoryBlockSchema[];
  /**
   * Per-session block resolver (see {@link CoreMemoryConfig.resolveBlocks}).
   * Forwarded to the post-compaction updater so world-declared blocks are also
   * refreshed during compaction, not just on the normal post-turn path.
   */
  readonly resolveBlocks?: (
    sessionId: string,
  ) => Promise<readonly CoreMemoryBlockSchema[] | undefined>;
}

export interface CompactionResult {
  readonly compacted: boolean;
  readonly summaryId?: string;
  readonly messagesBefore: number;
  readonly messagesAfter: number;
  readonly summary?: string;
}

// ── Unified Memory System ───────────────────────────────────────

/**
 * Inject-only embedding function for the semantic (vector) memory tier. The
 * memory package never imports a concrete provider; the server bootstrap layer
 * builds this from `@covel/ai-provider`'s gateway and passes it in, exactly as
 * it does for the {@link MemoryLLMAdapter}. Returns one embedding per input, in
 * order. Aliased from the vector-tier primitives so the public type surface
 * lives in one place.
 */
export type { EmbedFn } from "./vector-common.js";

export interface MemorySystemDeps {
  readonly store: DataStore;
  readonly llm: MemoryLLMAdapter;
  /** Resolve a slot name to a model identifier. */
  readonly resolveSlot?: (slot: string) => string | undefined;
  /**
   * Optional embedding function. When present AND the store supports vectors,
   * recall/archival upgrade from keyword to semantic (vector) search and the
   * memory system gains a real embed-on-write {@link MemorySystem.ingest} path.
   * When absent, the system stays keyword-only (every existing deployment).
   */
  readonly embed?: import("./vector-common.js").EmbedFn;
}

/**
 * Unified facade combining all memory tiers.
 * Created once at server bootstrap, shared across all turn executions.
 */
export interface MemorySystem {
  readonly manager: MemoryManager;
  readonly updater: MemoryUpdater;
  readonly recall: RecallSearcher;
  readonly archival: ArchivalSearcher;

  /**
   * Embed-on-write ingestion sweep for the semantic memory tier. Embeds turn
   * messages (recall) and lorebook + character records (archival) that are new
   * or changed since the last sweep, and upserts them into the session's vector
   * space. Idempotent, incremental, and best-effort: callers fire-and-forget it
   * post-turn (never on the hot path), and it never throws on a store/embed
   * failure. A no-op (returns `skipped: true`) when no embedding model is
   * configured or the store has no vector capability — so keyword-only
   * deployments are unaffected.
   */
  ingest(sessionId: string): Promise<{
    readonly skipped: boolean;
    readonly recall: number;
    readonly archival: number;
  }>;

  /**
   * Run compaction if needed.
   * Returns the compaction result (including whether it actually compacted).
   */
  compact(params: {
    sessionId: string;
    estimatedTokens: number;
    contextWindow: number;
    messages: readonly {
      id: string;
      role: string;
      content: string;
      turnId?: string;
      createdAt: string;
    }[];
  }): Promise<CompactionResult>;
}
