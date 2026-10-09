/**
 * Recall Memory — search of the conversation, with no embedding model.
 *
 * Ranks the recent turn messages and the history summaries with BM25
 * (`rankTexts`). The summaries cover the turns that are older than the scanned
 * messages, so a long session still answers a question about its start.
 *
 * `createMemorySystem` puts the vector searcher in front of this one when an
 * embedding function and vector storage are present; the vector searcher falls
 * back here when a session has no embedding model locked, its index is empty,
 * or embedding fails. Both implement {@link RecallSearcher}.
 */

import { rankTexts, searchExcerpt } from "@covel/plugin-handlers-utils";
import type { RecallStore } from "./store-contracts.js";
import type { RecallSearchResult, RecallSearcher } from "./types.js";

/** Most recent messages to rank. Older turns are reached through their summaries. */
const MAX_SCAN_MESSAGES = 500;

/** Role of a result that is a history summary, not one message. */
export const SUMMARY_ROLE = "summary";

export function createKeywordRecallSearcher(
  store: RecallStore,
): RecallSearcher {
  return {
    async search(
      sessionId,
      query,
      limit = 10,
    ): Promise<readonly RecallSearchResult[]> {
      const [messages, summaries] = await Promise.all([
        store.listRecentTurnMessages(sessionId, MAX_SCAN_MESSAGES),
        store.listSessionSummaries(sessionId),
      ]);
      // Newest first: of two equal scores the later one is returned first.
      const candidates = [
        ...messages
          .map((message) => ({
            turnId: message.turnId ?? "",
            role: message.role,
            content: String(message.content ?? ""),
            timestamp: message.createdAt,
          }))
          .reverse(),
        ...summaries
          .map((summary) => ({
            turnId: summary.turnRangeEnd,
            role: SUMMARY_ROLE,
            content: summary.content,
            timestamp: summary.createdAt,
          }))
          .reverse(),
      ].filter((candidate) => candidate.content.trim());

      return rankTexts(
        query,
        candidates.map((candidate) => candidate.content),
        { limit },
      ).map(({ index, score }) => {
        const candidate = candidates[index]!;
        return {
          ...candidate,
          content: searchExcerpt(candidate.content, query),
          score,
        };
      });
    },
  };
}
