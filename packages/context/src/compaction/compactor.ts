import type { TextMessage } from "@covel/ai-provider";
import type { CharacterCard } from "@covel/shared";
import type {
  CompactionConfig,
  CompactionResult,
  CompactionStats,
  RehydrationBundle,
} from "./types.js";
import { DEFAULT_COMPACTION_CONFIG } from "./types.js";

/** Estimate token count from text (~4 chars per token) */
export function estimateTokens(messages: readonly TextMessage[]): number {
  let chars = 0;
  for (const msg of messages) {
    chars += (msg.content ?? "").length;
  }
  return Math.ceil(chars / 4);
}

/**
 * Check whether compaction is needed based on token estimate.
 */
export function needsCompaction(
  messages: readonly TextMessage[],
  config?: Partial<CompactionConfig>
): boolean {
  const threshold =
    config?.tokenThreshold ?? DEFAULT_COMPACTION_CONFIG.tokenThreshold;
  return estimateTokens(messages) > threshold;
}

/**
 * Compact chat history using a staged approach.
 *
 * Stage 1 (structural, no LLM):
 * - Truncate oversized individual messages
 * - Remove duplicate state snapshot messages
 * - Extract narrative segments for summary
 *
 * Stage 2 (LLM summary) is not implemented in this first round —
 * the function signature accepts an optional summarizer callback
 * for future integration.
 */
export async function compactChatHistory(
  messages: readonly TextMessage[],
  config?: Partial<CompactionConfig>,
  context?: {
    state?: Record<string, unknown>;
    characters?: CharacterCard[];
    phase?: string;
    events?: Array<{ type: string; payload: unknown }>;
  },
  summarizer?: (text: string) => Promise<string>
): Promise<CompactionResult> {
  const cfg = { ...DEFAULT_COMPACTION_CONFIG, ...config };
  const originalCount = messages.length;
  const tokensBefore = estimateTokens(messages);

  // Split into compactable (older) and preserved (recent)
  const splitIndex = Math.max(0, messages.length - cfg.preserveRecentCount);
  const toCompact = messages.slice(0, splitIndex);
  const preserved = messages.slice(splitIndex).map((m) => ({ ...m }));

  // ── Stage 1: Structural compaction ──────────────────────────────
  let truncated = 0;
  let removed = 0;

  // 1a. Truncate oversized messages in preserved set
  for (const msg of preserved) {
    const content = msg.content ?? "";
    if (content.length > cfg.truncateMessageChars) {
      const half = Math.floor(cfg.truncateMessageChars / 2);
      msg.content =
        content.slice(0, half) +
        "\n\n[... content truncated ...]\n\n" +
        content.slice(-half);
      truncated++;
    }
  }

  // 1b. Extract narrative from compacted messages
  const narrativeSegments: string[] = [];

  for (const msg of toCompact) {
    const content = msg.content ?? "";
    if (msg.role === "assistant") {
      // Collect assistant narrative (may be long — take first 500 chars)
      const preview =
        content.length > 500
          ? content.slice(0, 500) + "..."
          : content;
      narrativeSegments.push(preview);
    }
  }

  removed = toCompact.length;

  // Build structural summary
  let summary: string;
  const narrativePreview = narrativeSegments.slice(-5).join("\n---\n");

  if (summarizer && narrativeSegments.length > 0) {
    // Stage 2: LLM summary
    const textToSummarize = narrativeSegments.join("\n---\n");
    try {
      summary = await summarizer(textToSummarize);
    } catch {
      // Fallback to structural summary on LLM failure
      summary = buildStructuralSummary(narrativePreview, removed);
    }
  } else {
    summary = buildStructuralSummary(narrativePreview, removed);
  }

  // Build rehydration bundle
  const rehydration: RehydrationBundle = {
    state: context?.state ? { ...context.state } : {},
    activeCharacters: context?.characters
      ? context.characters.map((c) => ({ ...c }))
      : [],
    recentEvents: context?.events
      ? context.events.slice(-cfg.preserveRecentEvents)
      : [],
    phase: context?.phase ?? "playing",
    narrativeSummary:
      narrativeSegments.length > 0
        ? narrativeSegments[narrativeSegments.length - 1]
        : "",
  };

  const tokensAfter = estimateTokens(preserved);

  const stats: CompactionStats = {
    originalCount,
    resultCount: preserved.length,
    tokensBefore,
    tokensAfter: tokensAfter + Math.ceil(summary.length / 4),
    truncated,
    removed,
  };

  return {
    boundaryIndex: splitIndex,
    summary,
    preservedMessages: preserved,
    rehydration,
    stage: summarizer ? "llm-summary" : "structural",
    stats,
  };
}

function buildStructuralSummary(
  narrativePreview: string,
  removedCount: number
): string {
  const parts: string[] = [];
  parts.push(
    `[Compacted: ${removedCount} earlier messages have been summarized]`
  );

  if (narrativePreview) {
    parts.push("");
    parts.push("Recent narrative highlights:");
    parts.push(narrativePreview);
  }

  return parts.join("\n");
}
