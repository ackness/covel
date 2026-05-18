/**
 * Compactor (S2-T2) — summarize old history into a structured summary block.
 *
 * When the estimated token count of the current prompt assembly exceeds a
 * configurable threshold (default 60% of the slot's contextWindow), the
 * compactor:
 *
 *   1. Partitions the message list into a "to-compact" prefix and a protected
 *      tail (last 2 user turns AND last 5 messages overall are always protected).
 *   2. Calls the `fast` slot LLM with a fixed framework system prompt and a
 *      user prompt built from the messages to compact.
 *   3. Persists a `SessionSummaryRecord` containing the generated summary.
 *   4. Tags the original messages with `compactedAtTurnId = summaryId` so the
 *      prompt-build path can substitute the summary in their place.
 *
 * The compactor does NOT read environment configuration itself. The caller
 * decides whether a compactor instance is available.
 *
 * Original messages are NEVER deleted. They are only tagged.
 *
 * No cascade-compact: if any message in the to-compact window already has
 * a `compactedAtTurnId` set, the whole compaction is skipped for this round.
 */

import type {
  SessionContextStore,
  SessionSummaryRecord,
  TurnMessageRecord,
} from "./session-context-store.js";
import type { TokenEstimator } from "./budget.js";
import { loadPrompt, interpolate } from "./prompts-loader.js";

// ── Public types ────────────────────────────────────────────────

/** A minimal LLM adapter interface — same shape as `@covel/runtime`'s LLMAdapter. */
export interface CompactorLLMAdapter {
  complete(params: {
    systemPrompt: string;
    messages: readonly { role: "user"; content: string }[];
    model?: string;
  }): Promise<{ content: string }>;
}

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
  ): Promise<void>;
}

// ── Internal helpers ─────────────────────────────────────────────

const DEFAULT_THRESHOLD = 0.6;
const DEFAULT_PROTECT_LAST_USER_TURNS = 2;
const DEFAULT_PROTECT_LAST_N_MESSAGES = 5;

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
): string {
  const formatted = messages
    .map((m) => `[${m.role}]: ${m.content}`)
    .join("\n\n");

  if (locale === "zh-CN") {
    return `请将以下对话历史摘要化：\n\n${formatted}`;
  }
  return `Please summarize the following conversation history:\n\n${formatted}`;
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
 * - The estimated token count is below the threshold.
 * - There are no messages to compact (the protect window covers everything).
 * - Any message in the to-compact window already has `compactedAtTurnId` set
 *   (no cascade-compaction).
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

  // 1. Estimate total tokens
  const systemTokens = deps.estimator(systemPrompt);
  const messageTokens = messages.reduce(
    (sum, m) => sum + deps.estimator(m.content),
    0,
  );
  const totalTokens = systemTokens + messageTokens;
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

  // Nothing to compact (protect window covers everything)
  if (protectStart === 0) {
    return { compacted: false };
  }

  const toCompact = messages.slice(0, protectStart);

  // No cascade: if any message in to-compact is already tagged, skip
  if (toCompact.some((m) => m.compactedAtTurnId != null)) {
    return { compacted: false };
  }

  // Need at least 1 message to compact
  if (toCompact.length === 0) {
    return { compacted: false };
  }

  // 3. Build prompts and call fast LLM
  let compactorSystemPrompt: string;
  try {
    compactorSystemPrompt = await buildCompactorSystemPrompt(
      locale,
      focusSections,
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[compactor] Failed to load prompt template for session ${sessionId}: ${message}. Skipping compaction.`,
    );
    return { compacted: false };
  }
  const compactorUserPrompt = buildCompactorUserPrompt(toCompact, locale);

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

  // 4. Persist the summary record
  const summaryId = crypto.randomUUID();
  const now = new Date().toISOString();

  // Determine turn range from the first/last messages in toCompact
  const turnRangeStart = toCompact[0]!.turnId;
  const turnRangeEnd = toCompact[toCompact.length - 1]!.turnId;

  const summaryRecord: SessionSummaryRecord = {
    id: summaryId,
    sessionId,
    turnRangeStart,
    turnRangeEnd,
    content: summaryContent,
    focusSections,
    createdAt: now,
  };

  await deps.store.saveSessionSummary(summaryRecord);

  // 5. Tag the compacted messages
  const messageIds = toCompact.map((m) => m.id);
  await deps.store.tagTurnMessagesCompacted(sessionId, messageIds, summaryId);

  // 6. Emit trace event
  try {
    await deps.store.addTraceEvent({
      id: crypto.randomUUID(),
      sessionId,
      type: "context.compacted",
      traceId: summaryId,
      turnId: turnRangeEnd,
      payload: {
        summaryId,
        messagesCompacted: toCompact.length,
        tokenSavings: toCompact.reduce(
          (sum, m) => sum + deps.estimator(m.content),
          0,
        ),
        focusSections,
      },
      createdAt: now,
    });
  } catch {
    // Non-critical trace event — don't fail compaction if trace write fails
  }

  return { compacted: true, summaryId };
}
