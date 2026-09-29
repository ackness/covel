import type { MemoryStore } from "./store-contracts.js";

// ── Recall Memory (conversation history search) ─────────────────

export interface RecallSearchResult {
  readonly turnId: string;
  readonly role: string;
  readonly content: string;
  /**
   * Relevance score (higher = more relevant). Keyword search uses lexical
   * term overlap; vector search converts distance via distanceToScore.
   * Scores are implementation-specific, not calibrated probabilities.
   */
  readonly score: number;
  readonly timestamp: string;
}

/**
 * Conversation-history search. `createMemorySystem` selects vector search
 * when embeddings and vector storage are available, with keyword fallback.
 * The vector ingestor indexes conversation history after turns.
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
  /** Relevance score (higher = more relevant); see {@link RecallSearchResult.score}. */
  readonly score: number;
  /**
   * Origin of the matched record. Built-in keyword and vector searchers
   * index lorebook and character records. `"plugin_data"` remains reserved
   * for searchers that index plugin-owned knowledge.
   */
  readonly source: "plugin_data" | "lorebook" | "character";
  readonly pluginId?: string;
  readonly namespace?: string;
}

/**
 * Cross-plugin knowledge search. Like {@link RecallSearcher}, the memory
 * system selects vector search when configured, with keyword fallback.
 */
export interface ArchivalSearcher {
  search(
    sessionId: string,
    query: string,
    limit?: number,
  ): Promise<readonly ArchivalSearchResult[]>;
}

// ── Unified Memory System ───────────────────────────────────────

export interface MemorySearchOptions {
  readonly scope?: "recall" | "archival" | "all";
  readonly limit?: number;
}

export type MemorySearchResult =
  | (RecallSearchResult & { readonly source: "recall" })
  | (Omit<ArchivalSearchResult, "source"> & {
      readonly source: `archival:${ArchivalSearchResult["source"]}`;
    });

/**
 * Inject-only embedding function for the semantic (vector) memory tier. The
 * memory package never imports a concrete provider; the server bootstrap layer
 * builds this from `@covel/ai-provider`'s gateway and passes it in, exactly as
 * other gateway primitives. Returns one embedding per input, in
 * order. Aliased from the vector-tier primitives so the public type surface
 * lives in one place.
 */
export type { EmbedFn } from "./vector-common.js";

export interface MemorySystemDeps {
  readonly store: MemoryStore;
  /**
   * Optional embedding function. When present AND the store supports vectors,
   * recall/archival upgrade from keyword to semantic (vector) search and the
   * memory system gains a real embed-on-write {@link MemorySystem.ingest} path.
   * When absent, the system stays keyword-only.
   */
  readonly embed?: import("./vector-common.js").EmbedFn;
  /**
   * Optional cross-process serialization for a complete vector-ingestion
   * sweep. Avoids redundant embedding work across instances; atomic index
   * batches preserve consistency even without this coordinator. Each instance
   * also coalesces concurrent requests for the same session.
   */
  readonly runIngestExclusive?: import("./vector-ingest.js").RunIngestExclusive;
}

/**
 * Unified facade combining all memory tiers.
 * Created once at server bootstrap, shared across all turn executions.
 */
export interface MemorySystem {
  readonly recall: RecallSearcher;
  readonly archival: ArchivalSearcher;
  /**
   * Search both tiers with one request-scoped query embedding per model.
   * Results interleave each tier's ranking (recall first on ties); source
   * scores remain local to their tier and must not be compared across tiers.
   */
  search(
    sessionId: string,
    query: string,
    options?: MemorySearchOptions,
  ): Promise<readonly MemorySearchResult[]>;
  /** Drain only this instance after the host has stopped producers. */
  drain(): Promise<import("./background-tasks.js").MemoryBackgroundDrainResult>;
  pendingTaskCount(): number;

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
}
