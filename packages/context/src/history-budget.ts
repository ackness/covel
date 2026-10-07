import {
  DEFAULT_LOCALE,
  type HistoryCompactionInput,
  type HistoryCompactionOutput,
  type CovelEventType,
} from "@covel/shared";
import type {
  SessionContextStore,
  SessionSummaryRecord,
  TurnMessageRecord,
} from "./session-context-store.js";
import type { TokenEstimator } from "./budget.js";
export interface CompactorDeps {
  readonly store: SessionContextStore;
  readonly estimator: TokenEstimator;
  readonly contextWindow: number;
  /** Input capacity of the summary model after its output reserve. */
  readonly inputWindow?: number;
  readonly compact: (
    input: HistoryCompactionInput,
  ) => Promise<HistoryCompactionOutput | undefined>;
}
export interface CompactorOptions {
  readonly threshold?: number;
  readonly locale?: string;
  readonly traceId?: string;
}
export interface CompactorResult {
  readonly compacted: boolean;
  readonly summaryId?: string;
}
export interface CompactorRunner {
  run(
    sessionId: string,
    systemPromptPreview: string,
    messages: readonly TurnMessageRecord[],
    locale?: string,
    traceId?: string,
    trace?: {
      readonly turnId: string;
      emit(
        type: CovelEventType,
        payload: Record<string, unknown>,
      ): Promise<void>;
    },
    /** Cancels the compaction provider together with the requesting execution. */
    signal?: AbortSignal,
  ): Promise<CompactorResult>;
}
/** Budget admission and atomic persistence; compaction policy belongs to a provider. */
export async function maybeCompact(
  sessionId: string,
  systemPrompt: string,
  messages: readonly TurnMessageRecord[],
  deps: CompactorDeps,
  opts?: CompactorOptions,
): Promise<CompactorResult> {
  const existingSummaries =
    (await deps.store.listSessionSummaries?.(sessionId)) ?? [];
  const untagged = messages.filter((m) => m.compactedAtTurnId == null);
  const estimatedTokens =
    deps.estimator(systemPrompt) +
    untagged.reduce((n, m) => n + deps.estimator(m.content), 0) +
    existingSummaries.reduce((n, s) => n + deps.estimator(s.content), 0);
  if (estimatedTokens <= deps.contextWindow * (opts?.threshold ?? 0.6))
    return { compacted: false };
  const maxTokens = Math.max(
    1,
    Math.min(
      Math.floor(deps.contextWindow),
      Math.max(128, Math.min(8_192, Math.floor(deps.contextWindow * 0.12))),
    ),
  );
  const summaryBudget = {
    maxTokens,
    maxSegmentTokens: Math.min(
      maxTokens,
      Math.max(128, Math.min(2_048, Math.floor(deps.contextWindow * 0.04))),
    ),
    maxSegments: 8,
  };
  const result = await deps.compact({
    messages,
    existingSummaries,
    contextWindow: deps.contextWindow,
    inputWindow: deps.inputWindow ?? deps.contextWindow,
    summaryBudget,
    estimatedTokens,
    locale: opts?.locale ?? DEFAULT_LOCALE,
  });
  if (!result) return { compacted: false };

  const invalid = (): never => {
    throw new Error("Invalid history compaction result");
  };
  if (!result.summaries.length) invalid();
  const replacedIds = new Set<string>();
  const messageIds: string[] = [];
  let replacementCursor = 0;
  let summaryTokens = 0;
  const now = new Date().toISOString();
  let nextCreatedAt = existingSummaries.reduce(
    (latest, s) => Math.max(latest, Date.parse(s.createdAt) + 1),
    Date.parse(now),
  );
  const records = result.summaries.map((segment): SessionSummaryRecord => {
    // New raw history and old summary merges have separate chronological spans.
    // A provider must never merge a disconnected old span with a fresh tail.
    if (
      !segment.content.trim() ||
      (segment.messageIds.length === 0) ===
        (segment.replacesSummaryIds.length === 0) ||
      deps.estimator(segment.content) > summaryBudget.maxSegmentTokens
    )
      invalid();
    const replaced = segment.replacesSummaryIds.map((id, index) => {
      const summary = existingSummaries[replacementCursor + index];
      if (
        !summary ||
        summary.id !== id ||
        summary.sessionId !== sessionId ||
        replacedIds.has(id)
      )
        invalid();
      replacedIds.add(id);
      return summary!;
    });
    replacementCursor += replaced.length;
    const source = untagged.slice(
      messageIds.length,
      messageIds.length + segment.messageIds.length,
    );
    if (
      source.length !== segment.messageIds.length ||
      source.some(
        (m, index) =>
          m.sessionId !== sessionId || m.id !== segment.messageIds[index],
      )
    )
      invalid();
    messageIds.push(...segment.messageIds);
    summaryTokens += deps.estimator(segment.content);
    return {
      id: replaced[0]?.id ?? crypto.randomUUID(),
      sessionId,
      turnRangeStart: replaced[0]?.turnRangeStart ?? source[0]!.turnId,
      turnRangeEnd: replaced.at(-1)?.turnRangeEnd ?? source.at(-1)!.turnId,
      content: segment.content,
      focusSections: segment.focusSections,
      // Replacing an old prefix retains its chronological position when only
      // uncompacted messages are loaded and summaries are rendered up front.
      createdAt:
        replaced[0]?.createdAt ?? new Date(nextCreatedAt++).toISOString(),
    };
  });
  if (new Set(messageIds).size !== messageIds.length) invalid();
  const retained = existingSummaries.filter((s) => !replacedIds.has(s.id));
  if (
    retained.length + records.length > summaryBudget.maxSegments ||
    summaryTokens +
      retained.reduce((n, s) => n + deps.estimator(s.content), 0) >
      summaryBudget.maxTokens
  )
    invalid();

  const persisted = await deps.store.withTransaction(async (store) => {
    // Recheck inside the transaction so stale generation cannot replace a
    // newer compaction that completed during the provider call.
    const current = (await store.listSessionSummaries?.(sessionId)) ?? [];
    if (
      current.length !== existingSummaries.length ||
      current.some(
        (s, i) =>
          s.id !== existingSummaries[i]!.id ||
          s.content !== existingSummaries[i]!.content,
      )
    )
      throw new Error("History summaries changed during compaction");
    if (messageIds.length > 0) {
      // A history transform may filter or reorder its prompt projection. Only
      // a prefix of the canonical log may be hidden behind an upfront summary.
      const canonical = await store.listUncompactedTurnMessages(
        sessionId,
        messageIds.length,
      );
      if (
        canonical.length !== messageIds.length ||
        canonical.some((message, index) => message.id !== messageIds[index])
      )
        return false;
    }
    for (let index = 0; index < records.length; index++) {
      const record = records[index]!;
      const segment = result.summaries[index]!;
      if (segment.replacesSummaryIds.length) {
        await store.retagCompactedTurnMessages(
          sessionId,
          record.id,
          segment.replacesSummaryIds,
        );
        await store.deleteSessionSummaries(
          sessionId,
          segment.replacesSummaryIds,
        );
      }
      await store.saveSessionSummary(record);
      if (segment.messageIds.length) {
        await store.tagTurnMessagesCompacted(
          sessionId,
          segment.messageIds,
          record.id,
        );
      }
    }
    return true;
  });
  if (!persisted) return { compacted: false };
  const summaryId = records.at(-1)!.id;
  const turnRangeEnd = records.at(-1)!.turnRangeEnd;
  try {
    await deps.store.addTraceEvent({
      id: crypto.randomUUID(),
      sessionId,
      type: "context.compacted",
      traceId: opts?.traceId ?? summaryId,
      turnId: turnRangeEnd,
      payload: {
        summaryId,
        summaryIds: records.map((record) => record.id),
        messagesCompacted: messageIds.length,
        tokenSavings: untagged
          .slice(0, messageIds.length)
          .reduce((n, m) => n + deps.estimator(m.content), 0),
        focusSections: [
          ...new Set(records.flatMap((record) => record.focusSections)),
        ],
        summariesMerged: replacedIds.size,
        summaryTokens,
        totalSummaryTokens:
          summaryTokens +
          retained.reduce((n, s) => n + deps.estimator(s.content), 0),
        summaryTruncated: result.summaries.some((segment) => segment.truncated),
      },
      createdAt: now,
    });
  } catch {
    // Trace persistence is non-critical after the summary transaction commits.
  }
  return { compacted: true, summaryId };
}
