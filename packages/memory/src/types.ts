/**
 * @covel/memory — Three-tier memory system inspired by Letta (MemGPT).
 *
 * Memory tiers:
 *   1. Core Memory Blocks — Editable text segments inside the context window.
 *      Updated post-turn by a framework-driven LLM summarizer.
 *   2. Recall Memory — Searchable conversation history (keyword / vector).
 *   3. Archival Memory — Long-term cross-plugin knowledge (plugin_data + lorebook).
 *
 * Compaction — Older messages are summarized and replaced in prompts.
 *   Core memory blocks are updated simultaneously so key information survives.
 */

import type { DataStore } from "@covel/store";

// ── Core Memory Blocks ──────────────────────────────────────────

/**
 * Well-known core memory block labels.
 *
 * - `story_state`: Plot summary, active quests, revealed secrets, unresolved threads
 * - `scene`: Current location, time of day, atmosphere, immediate environment
 * - `character_relationships`: Key NPC relationships and attitudes toward player
 * - `player_profile`: Player character summary, abilities, current status
 */
export type CoreMemoryLabel =
  | "story_state"
  | "character_relationships"
  | "scene"
  | "player_profile";

export const CORE_MEMORY_LABELS: readonly CoreMemoryLabel[] = [
  "story_state",
  "character_relationships",
  "scene",
  "player_profile",
] as const;

/**
 * Display metadata for each core memory label. Owned by the memory
 * framework (same level as CORE_MEMORY_LABELS) — not by any specific
 * plugin. UI panels (whether json-render specs or React) consume this
 * to render friendly labels and icons.
 *
 * Icons use Lucide icon names. UI layers map them to actual components.
 */
export interface CoreMemoryLabelInfo {
  readonly displayName: { readonly zh: string; readonly en: string };
  readonly icon: string;
}

export const CORE_MEMORY_LABEL_INFO: Readonly<
  Record<CoreMemoryLabel, CoreMemoryLabelInfo>
> = {
  story_state: {
    displayName: { zh: "剧情状态", en: "Story State" },
    icon: "BookOpen",
  },
  scene: {
    displayName: { zh: "当前场景", en: "Current Scene" },
    icon: "MapPin",
  },
  character_relationships: {
    displayName: { zh: "角色关系", en: "Character Relationships" },
    icon: "Users",
  },
  player_profile: {
    displayName: { zh: "玩家状态", en: "Player Profile" },
    icon: "User",
  },
};

/** Default max characters per block (not tokens — char count is cheaper to check). */
export const DEFAULT_MAX_BLOCK_CHARS = 2000;

export interface CoreMemoryBlock {
  readonly label: CoreMemoryLabel;
  readonly content: string;
  readonly updatedAt: string;
}

export interface CoreMemoryConfig {
  /** Max characters per block. Default: 2000. */
  readonly maxBlockChars?: number;
  /** Subset of labels to manage. Default: all. */
  readonly labels?: readonly CoreMemoryLabel[];
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

/** Minimal LLM adapter for the memory updater. */
export interface MemoryLLMAdapter {
  complete(params: {
    systemPrompt: string;
    messages: readonly { role: "user" | "assistant"; content: string }[];
    model?: string;
  }): Promise<{ content: string }>;
}

export interface MemoryUpdaterConfig {
  /** Model slot name for the summarizer. Resolution: memory → story. */
  readonly modelSlot?: string;
  /** Locale for the updater prompt. Default: zh-CN. */
  readonly locale?: string;
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
  readonly score: number;
  readonly timestamp: string;
}

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
  readonly score: number;
  readonly source: "plugin_data" | "lorebook" | "character";
  readonly pluginId?: string;
  readonly namespace?: string;
}

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
}

export interface CompactionResult {
  readonly compacted: boolean;
  readonly summaryId?: string;
  readonly messagesBefore: number;
  readonly messagesAfter: number;
  readonly summary?: string;
}

// ── Unified Memory System ───────────────────────────────────────

export interface MemorySystemDeps {
  readonly store: DataStore;
  readonly llm: MemoryLLMAdapter;
  /** Resolve a slot name to a model identifier. */
  readonly resolveSlot?: (slot: string) => string | undefined;
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
