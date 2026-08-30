/**
 * Compactor — summarize old history into a structured summary block.
 *
 * When the estimated token count of the current prompt assembly exceeds a
 * configurable threshold (default 60% of the slot's contextWindow), the
 * compactor:
 *
 *   1. Partitions the message list into a "to-compact" prefix and a protected
 *      tail (last 2 user turns AND last 5 messages overall are always protected).
 *   2. Calls the `fast` slot LLM with a fixed framework system prompt and a
 *      user prompt built from the prior rolling summary + messages to compact.
 *   3. Persists one bounded `SessionSummaryRecord` for the whole compacted
 *      prefix, replacing the prior summary atomically.
 *   4. Retags the compacted prefix with the replacement summary id so the
 *      prompt-build path never observes an orphan reference.
 *
 * The compactor does NOT read environment configuration itself. The caller
 * decides whether a compactor instance is available.
 *
 * Original messages are NEVER deleted. They are only tagged.
 *
 * Multi-round compaction: each round folds the new uncompacted region into the
 * prior rolling summary. Summary count and summary token cost therefore stay
 * bounded for the life of the session. The token estimate mirrors the
 * effective prompt view (the summary substitutes its tagged raw messages —
 * see `message-insertion.ts`), not the raw history.
 */

import type { SimpleCompletionAdapter } from "@covel/shared";
import type {
  SessionContextStore,
  SessionSummaryRecord,
  TurnMessageRecord,
} from "./session-context-store.js";
import type { TokenEstimator } from "./budget.js";
import { loadPrompt, interpolate } from "./prompts-loader.js";

// ── Public types ────────────────────────────────────────────────

/**
 * Minimal single-call LLM adapter the compactor needs. Aliased to the shared
 * {@link SimpleCompletionAdapter} (single source of truth in `@covel/shared`),
 * pinned to `"user"` messages because compaction only ever sends a user-role
 * prompt. Re-exported under this name for backward compatibility.
 */
export type CompactorLLMAdapter = SimpleCompletionAdapter<"user">;

export interface CompactorDeps {
  readonly store: SessionContextStore;
  readonly estimator: TokenEstimator;
  /** LLM adapter bound to the 'fast' slot. */
  readonly fastSlotLlm: CompactorLLMAdapter;
  /** Total context window size in tokens for the active slot. */
  readonly contextWindow: number;
}

export interface CompactorOptions {
  /** Fraction of contextWindow that triggers compaction. Default: 0.6. */
  readonly threshold?: number;
  /** Number of trailing user messages (plus everything after them) to protect. Default: 2. */
  readonly protectLastNUserTurns?: number;
  /** Always protect at least this many messages from the tail. Default: 5. */
  readonly protectLastNMessages?: number;
  /** Deduped list of focus sections from active plugins' summaryFocus fields. */
  readonly focusSections?: readonly string[];
  readonly locale?: "zh-CN" | "en-US";
  /**
   * The current turn's traceId. When set, the `context.compacted` trace event
   * is filed under it so it is queryable alongside the rest of the turn instead
   * of under a standalone summaryId (audit 2026-07-16 L-8).
   */
  readonly traceId?: string;
}

export interface CompactorResult {
  readonly compacted: boolean;
  readonly summaryId?: string;
}

// ── CompactorRunner interface (for turn-executor injection) ──────

/**
 * Thin interface the server bootstraps and injects into turn-executor.
 * The runner wraps `maybeCompact` with session-specific context that the
 * generic compactor function doesn't know about (session ID, locale,
 * focus sections from active plugins).
 */
export interface CompactorRunner {
  run(
    sessionId: string,
    systemPromptPreview: string,
    messages: readonly TurnMessageRecord[],
    /**
     * Session locale. Threaded into the compaction prompt + focus sections so a
     * non-Chinese session's history summaries are generated in its own language
     * instead of always falling back to zh-CN.
     */
    locale?: string,
    /** Current turn's traceId, so the compaction trace joins the turn (L-8). */
    traceId?: string,
  ): Promise<CompactorResult>;
}

// ── Internal helpers ─────────────────────────────────────────────

const DEFAULT_THRESHOLD = 0.6;
const DEFAULT_PROTECT_LAST_USER_TURNS = 2;
const DEFAULT_PROTECT_LAST_N_MESSAGES = 5;
const SUMMARY_TOKEN_FRACTION = 0.04;
const MIN_SUMMARY_TOKENS = 128;
const MAX_SUMMARY_TOKENS = 1_024;

/**
 * Default focus sections used when the caller does not supply any. The actual
 * text is locale-aware so the summary LLM gets a sensible bullet list to expand
 * on.
 */
const DEFAULT_FOCUS_SECTIONS: Record<"zh-CN" | "en-US", readonly string[]> = {
  "zh-CN": ["关键事件", "人物关系", "环境状态"],
  "en-US": ["Key events", "Character relationships", "World state"],
};

/**
 * Build the framework system prompt for the summary LLM call.
 *
 * The template lives at `prompts/server/compactor.{zh,en}.md` and is loaded
 * via `loadPrompt()` so prompt edits do not require a rebuild.
 *
 * The single template variable is `{{ sections }}`. To preserve the
 * pre-externalization rendering (one section per bullet line), we join the
 * `focusSections` array with `\n- ` so the leading `- ` from the markdown
 * template lines up with the first item.
 */
async function buildCompactorSystemPrompt(
  locale: "zh-CN" | "en-US",
  focusSections: readonly string[],
): Promise<string> {
  const effective =
    focusSections.length > 0 ? focusSections : DEFAULT_FOCUS_SECTIONS[locale];
  const template = await loadPrompt("server", "compactor", locale);
  return interpolate(template, {
    sections: effective.join("\n- "),
  }).trimEnd();
}

/**
 * Build the user prompt: list of sections + the messages to compact.
 */
function buildCompactorUserPrompt(
  messages: readonly TurnMessageRecord[],
  locale: "zh-CN" | "en-US",
  priorSummaries: readonly SessionSummaryRecord[],
  maxSummaryTokens: number,
): string {
  const formatted = messages
    .map((m) => `[${m.role}]: ${m.content}`)
    .join("\n\n");
  const prior = priorSummaries
    .map((summary) => summary.content)
    .join("\n\n---\n\n");

  if (locale === "zh-CN") {
    return prior
      ? `请把已有滚动摘要与新增对话合并成一份完整摘要，不能遗漏仍有效的名称、约定、位置、关系、状态和因果。最终摘要不超过约 ${maxSummaryTokens} tokens。\n\n<已有滚动摘要>\n${prior}\n</已有滚动摘要>\n\n<新增对话>\n${formatted}\n</新增对话>`
      : `请将以下对话历史摘要化，最终摘要不超过约 ${maxSummaryTokens} tokens：\n\n${formatted}`;
  }
  return prior
    ? `Merge the existing rolling summary and new conversation into one complete summary. Preserve all still-valid names, agreements, locations, relationships, states, and causal links. Keep the final summary under approximately ${maxSummaryTokens} tokens.\n\n<existing_rolling_summary>\n${prior}\n</existing_rolling_summary>\n\n<new_conversation>\n${formatted}\n</new_conversation>`
    : `Please summarize the following conversation history in approximately ${maxSummaryTokens} tokens or fewer:\n\n${formatted}`;
}

function resolveSummaryTokenBudget(contextWindow: number): number {
  return Math.min(
    MAX_SUMMARY_TOKENS,
    Math.max(
      MIN_SUMMARY_TOKENS,
      Math.floor(contextWindow * SUMMARY_TOKEN_FRACTION),
    ),
  );
}

function boundSummaryContent(
  content: string,
  maxTokens: number,
  estimator: TokenEstimator,
  locale: "zh-CN" | "en-US",
): { readonly content: string; readonly truncated: boolean } {
  const trimmed = content.trim();
  if (estimator(trimmed) <= maxTokens) {
    return { content: trimmed, truncated: false };
  }

  const marker =
    locale === "zh-CN"
      ? "\n[摘要已按上下文预算截断]"
      : "\n[Summary truncated to context budget]";
  let low = 0;
  let high = trimmed.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = `${trimmed.slice(0, mid).trimEnd()}${marker}`;
    if (estimator(candidate) <= maxTokens) low = mid;
    else high = mid - 1;
  }
  return {
    content: `${trimmed.slice(0, low).trimEnd()}${marker}`,
    truncated: true,
  };
}

/**
 * Walk backwards through the message list to find the index at which the
 * protect window begins — mirrors the logic in budget.ts.
 *
 * Protects:
 * - the last `protectLastNUserTurns` user messages (and everything after them)
 * - at least the last `protectLastNMessages` messages overall
 *
 * Returns the index of the first protected message. Everything at/after this
 * index is off-limits for compaction.
 */
function computeProtectStart(
  messages: readonly TurnMessageRecord[],
  protectLastNUserTurns: number,
  protectLastNMessages: number,
): number {
  const n = messages.length;
  if (n === 0) return 0;

  // Absolute tail protection
  const tailProtect = Math.max(0, n - protectLastNMessages);

  // User-turn protection
  let userTurnProtect = n; // default: protect everything
  let userSeen = 0;
  for (let i = n - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") {
      userSeen += 1;
      if (userSeen >= protectLastNUserTurns) {
        userTurnProtect = i;
        break;
      }
    }
  }
  if (userSeen < protectLastNUserTurns) {
    userTurnProtect = 0; // protect entire list
  }

  // The more conservative (earlier) boundary wins
  return Math.min(tailProtect, userTurnProtect);
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Attempt to compact the oldest portion of the message history for a session.
 *
 * The function is a no-op when:
 * - The estimated token count (effective prompt view: summaries + uncompacted
 *   messages) is below the threshold.
 * - There are no uncompacted messages between the last compaction boundary
 *   and the protect window.
 * - The fast LLM call fails (logs and returns `{ compacted: false }`).
 *
 * @param sessionId - Session to compact.
 * @param systemPrompt - The assembled system prompt for the current runtime
 *   (used only for token estimation; the compactor does not modify it).
 * @param messages - All `TurnMessageRecord`s for the session, in chronological order.
 * @param deps - Store, estimator, fast LLM adapter, context window size.
 * @param opts - Optional tuning parameters.
 */
export async function maybeCompact(
  sessionId: string,
  systemPrompt: string,
  messages: readonly TurnMessageRecord[],
  deps: CompactorDeps,
  opts?: CompactorOptions,
): Promise<CompactorResult> {
  const threshold = opts?.threshold ?? DEFAULT_THRESHOLD;
  const protectLastNUserTurns =
    opts?.protectLastNUserTurns ?? DEFAULT_PROTECT_LAST_USER_TURNS;
  const protectLastNMessages =
    opts?.protectLastNMessages ?? DEFAULT_PROTECT_LAST_N_MESSAGES;
  const focusSections = opts?.focusSections ?? [];
  const locale = opts?.locale ?? "zh-CN";

  // 1. Estimate tokens from the effective prompt view. Already-compacted raw
  //    messages are substituted by their summary at prompt-build time (see
  //    message-insertion.ts), so counting their raw content would permanently
  //    inflate the estimate and re-trigger compaction after the first round.
  const systemTokens = deps.estimator(systemPrompt);
  let lastCompactedIndex = -1;
  let messageTokens = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.compactedAtTurnId != null) {
      lastCompactedIndex = i;
    } else {
      messageTokens += deps.estimator(m.content);
    }
  }
  // Count ALL session summaries, not just those referenced by `messages`:
  // callers now pass the uncompacted suffix (listUncompactedTurnMessages),
  // where compacted rows — and thus their summary references — are absent.
  // Every summary is part of the effective prompt view either way (see
  // message-insertion.ts), so a full history yields the identical total.
  const existingSummaries = deps.store.listSessionSummaries
    ? await deps.store.listSessionSummaries(sessionId)
    : [];
  let summaryTokens = 0;
  for (const summary of existingSummaries) {
    summaryTokens += deps.estimator(summary.content);
  }
  const totalTokens = systemTokens + messageTokens + summaryTokens;
  const tokenThreshold = deps.contextWindow * threshold;

  if (totalTokens <= tokenThreshold) {
    return { compacted: false };
  }

  // 2. Partition: compute protect boundary
  const protectStart = computeProtectStart(
    messages,
    protectLastNUserTurns,
    protectLastNMessages,
  );

  // Compaction window = uncompacted region between the last already-tagged
  // message and the protect boundary. Starting after the last tagged message
  // lets later rounds pick up only the fresh region; prior summaries are fed
  // to the LLM separately and atomically replaced by the rolling result.
  const toCompact = messages.slice(lastCompactedIndex + 1, protectStart);

  // Nothing new to compact (protect window reaches the last boundary)
  if (toCompact.length === 0) {
    return { compacted: false };
  }

  // 3. Build prompts and call fast LLM
  const maxSummaryTokens = resolveSummaryTokenBudget(deps.contextWindow);
  const mergedFocusSections = [
    ...new Set([
      ...existingSummaries.flatMap((summary) => summary.focusSections),
      ...focusSections,
    ]),
  ];
  let compactorSystemPrompt: string;
  try {
    compactorSystemPrompt = await buildCompactorSystemPrompt(
      locale,
      mergedFocusSections,
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[compactor] Failed to load prompt template for session ${sessionId}: ${message}. Skipping compaction.`,
    );
    return { compacted: false };
  }
  const compactorUserPrompt = buildCompactorUserPrompt(
    toCompact,
    locale,
    existingSummaries,
    maxSummaryTokens,
  );

  let summaryContent: string;
  try {
    const response = await deps.fastSlotLlm.complete({
      systemPrompt: compactorSystemPrompt,
      messages: [{ role: "user", content: compactorUserPrompt }],
    });
    summaryContent = response.content;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[compactor] Fast LLM call failed for session ${sessionId}: ${message}. Skipping compaction.`,
    );
    return { compacted: false };
  }

  // A successful-but-empty response (safety filter, reasoning-only output, or a
  // provider returning content elsewhere) must NOT be persisted + tag the source
  // messages compacted — that would permanently replace real history with an
  // empty summary. Skip so the window keeps its messages and can compact later.
  if (!summaryContent.trim()) {
    console.warn(
      `[compactor] Empty summary from fast LLM for session ${sessionId}; skipping compaction to avoid dropping history.`,
    );
    return { compacted: false };
  }
  const boundedSummary = boundSummaryContent(
    summaryContent,
    maxSummaryTokens,
    deps.estimator,
    locale,
  );
  summaryContent = boundedSummary.content;

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
    content: summaryContent,
    focusSections: mergedFocusSections,
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
        focusSections: mergedFocusSections,
        summariesMerged: existingSummaries.length,
        summaryTokens: deps.estimator(summaryContent),
        summaryTruncated: boundedSummary.truncated,
      },
      createdAt: now,
    });
  } catch {
    // Non-critical trace event — don't fail compaction if trace write fails
  }

  return { compacted: true, summaryId };
}
