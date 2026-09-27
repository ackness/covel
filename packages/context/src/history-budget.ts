import {
  DEFAULT_LOCALE,
  type HistoryCompactionInput,
  type HistoryCompactionOutput,
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
  const result = await deps.compact({
    messages,
    existingSummaries,
    contextWindow: deps.contextWindow,
    estimatedTokens,
    locale: opts?.locale ?? DEFAULT_LOCALE,
  });
  if (!result || !result.content.trim() || !result.messageIds.length)
    return { compacted: false };
  // A provider may replace only a contiguous, uncompacted prefix in this session.
  // Reordering, skipping or referring to foreign messages must never hide history.
  const toCompact = untagged.slice(0, result.messageIds.length);
  if (
    toCompact.length !== result.messageIds.length ||
    toCompact.some(
      (m, i) => m.sessionId !== sessionId || m.id !== result.messageIds[i],
    ) ||
    new Set(result.messageIds).size !== result.messageIds.length ||
    deps.estimator(result.content) > deps.contextWindow
  ) {
    throw new Error("Invalid history compaction result");
  }
  // 4. Persist the summary record
  const summaryId = crypto.randomUUID();
  const now = new Date().toISOString();

  // Determine turn range from the first/last messages in toCompact
  const turnRangeStart =
    existingSummaries[0]?.turnRangeStart ?? toCompact[0]!.turnId;
  const turnRangeEnd = toCompact[toCompact.length - 1]!.turnId;

  const summaryRecord: SessionSummaryRecord = {
    id: summaryId,
    sessionId,
    turnRangeStart,
    turnRangeEnd,
    content: result.content,
    focusSections: result.focusSections,
    createdAt: now,
  };

  // 5. Persist the summary AND tag the compacted messages atomically.
  //
  // These two writes are one logical operation. Saving the summary without
  // tagging leaves an orphan: `message-insertion.ts` renders the summary as a
  // system message while the original history is still untagged and therefore
  // still injected — the same content twice, with the summary carrying system
  // authority. Tagging without a summary is worse: the history is hidden with
  // nothing standing in for it.
  const messageIds = toCompact.map((m) => m.id);
  const persistCompaction = async (
    store: Pick<
      typeof deps.store,
      | "deleteSessionSummaries"
      | "retagCompactedTurnMessages"
      | "saveSessionSummary"
      | "tagTurnMessagesCompacted"
    >,
  ): Promise<void> => {
    if (existingSummaries.length > 0) {
      await store.deleteSessionSummaries(sessionId);
    }
    await store.saveSessionSummary(summaryRecord);
    if (existingSummaries.length > 0) {
      await store.retagCompactedTurnMessages(sessionId, summaryId);
    }
    await store.tagTurnMessagesCompacted(sessionId, messageIds, summaryId);
  };

  await deps.store.withTransaction(persistCompaction);

  // 6. Emit trace event
  try {
    await deps.store.addTraceEvent({
      id: crypto.randomUUID(),
      sessionId,
      type: "context.compacted",
      traceId: opts?.traceId ?? summaryId,
      turnId: turnRangeEnd,
      payload: {
        summaryId,
        messagesCompacted: toCompact.length,
        tokenSavings: toCompact.reduce(
          (sum, m) => sum + deps.estimator(m.content),
          0,
        ),
        focusSections: result.focusSections,
        summariesMerged: existingSummaries.length,
        summaryTokens: deps.estimator(result.content),
        summaryTruncated: result.truncated ?? false,
      },
      createdAt: now,
    });
  } catch {
    // Non-critical trace event — don't fail compaction if trace write fails
  }

  return { compacted: true, summaryId };
}
