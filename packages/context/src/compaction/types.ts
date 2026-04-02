import type { TextMessage } from "@covel/ai-provider";
import type { CharacterCard } from "@covel/shared";

/** Configuration for compaction behavior */
export interface CompactionConfig {
  /** Token threshold that triggers compaction (default: 24000 ≈ 60% of 40k window) */
  tokenThreshold: number;
  /** Number of recent messages to preserve after compaction (default: 10) */
  preserveRecentCount: number;
  /** Number of recent events to include in rehydration bundle (default: 20) */
  preserveRecentEvents: number;
  /** Max characters per single message before truncation in Stage 1 (default: 4000) */
  truncateMessageChars: number;
}

/** Default compaction configuration */
export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  tokenThreshold: 24_000,
  preserveRecentCount: 10,
  preserveRecentEvents: 20,
  truncateMessageChars: 4_000,
};

/** Result of a compaction operation */
export interface CompactionResult {
  /** Boundary marker — content before this point has been compacted */
  boundaryIndex: number;
  /** LLM-generated summary (or structural summary for Stage 1 only) */
  summary: string;
  /** Preserved recent messages (not compacted) */
  preservedMessages: TextMessage[];
  /** Rehydration bundle — state the model still needs after compaction */
  rehydration: RehydrationBundle;
  /** Which compaction stage was used */
  stage: "structural" | "llm-summary";
  /** Stats about what was removed */
  stats: CompactionStats;
}

/** Rehydration bundle — runtime state that must survive compaction */
export interface RehydrationBundle {
  /** Current state snapshot */
  state: Record<string, unknown>;
  /** Active characters */
  activeCharacters: CharacterCard[];
  /** Recent events */
  recentEvents: Array<{ type: string; payload: unknown }>;
  /** Current run phase */
  phase: string;
  /** Narrative summary from compacted history */
  narrativeSummary: string;
}

/** Compacted chat history ready for prompt assembly */
export interface CompactedChatHistory {
  /** Compaction summary (injected as system context) */
  summary: string;
  /** Preserved recent messages */
  recentMessages: TextMessage[];
}

/** Statistics about what compaction removed */
export interface CompactionStats {
  /** Original message count */
  originalCount: number;
  /** Messages after compaction */
  resultCount: number;
  /** Estimated tokens before */
  tokensBefore: number;
  /** Estimated tokens after */
  tokensAfter: number;
  /** Number of messages truncated */
  truncated: number;
  /** Number of messages removed */
  removed: number;
}
