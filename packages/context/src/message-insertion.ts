/**
 * Message-array assembly helpers for the segment-based prompt assembler.
 *
 * Covers segment 7 (history with compaction substitution) and the depth/
 * author's-note insertion used by segments 9. Extracted from
 * `prompt-assembler.ts` so the assembler body focuses on segment composition.
 */

import { messageContentFromHistoryRecord } from "./llm-content-parts.js";
import type {
  LLMMessage,
  MessageHistoryRecord,
  SummaryRecord,
} from "./types.js";

export interface RenderedAuthorsNote {
  readonly role: "system" | "user" | "assistant";
  readonly depth: number;
  readonly content: string;
}

export interface RenderedDepthContribution {
  readonly role: "system" | "user" | "assistant";
  readonly depth: number;
  readonly content: string;
  readonly order: number;
}

/** See `context-builder.ts::toLLMMessage` — kept in lock-step. */
export function toLLMMessage(msg: MessageHistoryRecord): LLMMessage {
  return {
    role: msg.role as "system" | "user" | "assistant",
    content: messageContentFromHistoryRecord(msg),
    ...(msg.name ? { name: msg.name } : {}),
  };
}

/**
 * Segment 7 — history with optional compaction substitution. When a message
 * carries `compactedAtTurnId`, the first such message is replaced by its
 * summary and subsequent compacted messages are dropped.
 */
export function buildMessageHistoryWithSummaries(
  messageHistory: readonly MessageHistoryRecord[],
  summaries: readonly SummaryRecord[],
): LLMMessage[] {
  if (summaries.length === 0) {
    return messageHistory.map(toLLMMessage);
  }

  const summaryById = new Map(summaries.map((s) => [s.id, s]));
  const emittedSummaryIds = new Set<string>();
  const result: LLMMessage[] = [];

  for (const msg of messageHistory) {
    const compactedId = (
      msg as MessageHistoryRecord & { compactedAtTurnId?: string }
    ).compactedAtTurnId;

    if (compactedId) {
      if (!emittedSummaryIds.has(compactedId)) {
        const summary = summaryById.get(compactedId);
        if (summary) {
          emittedSummaryIds.add(compactedId);
          result.push({
            role: "system",
            content: `[Compacted history: sections=${JSON.stringify(summary.focusSections)}]\n\n${summary.content}`,
          });
        }
      }
      continue;
    }

    result.push(toLLMMessage(msg));
  }

  return result;
}

/**
 * Insert Author's Note bundles into a message array.
 *
 * Each bundle is placed before `messages[messages.length - depth]`. When
 * `depth <= 0` or `depth >= messages.length`, the bundle is appended at
 * the end (behaving like a post-history instruction). The returned array
 * is a new copy — the input is never mutated.
 */
export function insertAuthorsNotes(
  messages: readonly LLMMessage[],
  notes: readonly RenderedAuthorsNote[],
): LLMMessage[] {
  if (notes.length === 0) return [...messages];

  // Work with an indexed array; each bundle converts to one LLMMessage that
  // we splice into the correct slot. Build all insertions first, then apply
  // from highest index to lowest so earlier splices don't shift later ones.
  const insertions: Array<{ index: number; message: LLMMessage }> = notes.map(
    (note) => {
      const message: LLMMessage = { role: note.role, content: note.content };
      const len = messages.length;
      let index: number;
      if (note.depth <= 0 || len === 0) {
        index = len;
      } else if (note.depth >= len) {
        index = 0;
      } else {
        index = len - note.depth;
      }
      return { index, message };
    },
  );

  // Stable sort by insertion index descending; for equal indices, preserve
  // declaration order by reversing the tie-break so the final array shows
  // them in the original left-to-right order after splicing.
  const indexed = insertions.map((ins, order) => ({ ...ins, order }));
  indexed.sort((a, b) => b.index - a.index || b.order - a.order);

  const out: LLMMessage[] = [...messages];
  for (const ins of indexed) {
    out.splice(ins.index, 0, ins.message);
  }
  return out;
}

/**
 * Insert depth-positioned contributions (persona/lore at_depth). Converts each
 * to an author's-note bundle and delegates to {@link insertAuthorsNotes}.
 */
export function insertDepthContributions(
  messages: readonly LLMMessage[],
  contributions: readonly RenderedDepthContribution[],
): LLMMessage[] {
  if (contributions.length === 0) return [...messages];

  const notes = contributions.map((contribution) => ({
    role: contribution.role,
    depth: contribution.depth,
    content: contribution.content,
  }));
  return insertAuthorsNotes(messages, notes);
}
