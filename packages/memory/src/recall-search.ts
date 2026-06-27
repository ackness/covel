/**
 * Recall Memory — Searchable conversation history (keyword search).
 *
 * Like Letta's `conversation_search` tool, but **keyword-only**: term-overlap
 * scoring over recent turn messages (TF-IDF-lite, with a CJK substring path).
 * The `score` field is a lexical-overlap score, not vector similarity.
 *
 * Semantic (vector) recall is NOT wired yet — and deliberately not faked here.
 * The store's vector capability (`searchVectors`, sqlite-vec / pgvector) and the
 * `gateway.embed` operation both exist, but **nothing populates the per-session
 * vector tables**: there is no embed-on-write ingestion path for turn messages,
 * so a vector searcher would query empty tables and silently return nothing —
 * strictly worse than keyword. Turning this on is a cross-cutting follow-up
 * (embed turn messages on write + backfill existing sessions, then drop in a
 * `createVectorRecallSearcher` via the {@link RecallSearcher} interface — the
 * swap seam memory-system.ts already routes through). See memory-system.ts.
 */

import type { DataStore } from "@covel/store";
import type { RecallSearchResult, RecallSearcher } from "./types.js";

/** Max messages to scan for keyword search. */
const MAX_SCAN_MESSAGES = 500;

/**
 * Create a keyword-based recall searcher (no embeddings needed).
 * Scores by term overlap: split query into terms, count matches in each
 * message, normalize by message length.
 */
export function createKeywordRecallSearcher(store: DataStore): RecallSearcher {
  return {
    async search(
      sessionId,
      query,
      limit = 10,
    ): Promise<readonly RecallSearchResult[]> {
      const messages = await store.listTurnMessages(sessionId);

      // Take most recent N messages
      const candidates = messages.slice(-MAX_SCAN_MESSAGES);
      if (candidates.length === 0) return [];

      // Tokenize query into terms (split on whitespace and punctuation)
      const queryTerms = tokenize(query);
      if (queryTerms.length === 0) return [];

      // Score each message
      const scored: { msg: (typeof candidates)[number]; score: number }[] = [];

      for (const msg of candidates) {
        const content = String(msg.content ?? "");
        if (!content.trim()) continue;

        const msgTerms = tokenize(content);
        if (msgTerms.length === 0) continue;

        // Count how many query terms appear in the message
        const msgTermSet = new Set(msgTerms);
        let matchCount = 0;
        for (const qt of queryTerms) {
          if (msgTermSet.has(qt)) matchCount++;
          // Also check substring match for CJK (Chinese characters don't split on spaces)
          else if (content.includes(qt)) matchCount += 0.5;
        }

        if (matchCount === 0) continue;

        // Normalize: match ratio * inverse length penalty (prefer concise matches)
        const score =
          (matchCount / queryTerms.length) * Math.min(1, 200 / msgTerms.length);
        scored.push({ msg, score });
      }

      // Sort by score descending, then by recency
      scored.sort(
        (a, b) =>
          b.score - a.score || b.msg.createdAt.localeCompare(a.msg.createdAt),
      );

      return scored.slice(0, limit).map(({ msg, score }) => ({
        turnId: msg.turnId ?? "",
        role: msg.role,
        content: String(msg.content ?? ""),
        score,
        timestamp: msg.createdAt,
      }));
    },
  };
}

/** Simple tokenizer: split on whitespace/punctuation, lowercase, dedupe. */
function tokenize(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[\s,.:;!?，。：；！？、\-—""''()（）【】[\]{}]+/)
        .filter((t) => t.length >= 2),
    ),
  ];
}
