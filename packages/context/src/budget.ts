/**
 * Token budget + message pruning.
 *
 * Pure utility used by the context builder to drop the oldest conversation
 * messages when the estimated input-token total would overflow the LLM's
 * context window. Modeled after OpenCode's "protect the last N user turns"
 * rule.
 *
 * Design constraints:
 * - No dependency on @covel/ai-provider. The caller injects a TokenEstimator.
 * - Pure function: no env var reads, no module state, no logging.
 * - Deterministic: same inputs always yield the same output.
 */

import type { ContentPart } from "@covel/shared";

/**
 * Convert a message `content` value (string or content-part array) into the
 * flat text the estimator can consume. Image parts contribute their
 * MediaRef id so the estimate stays stable across runs without pretending
 * image bytes have a token cost.
 */
function flattenContent(content: string | readonly ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) =>
      part.type === "text" ? part.text : `[image:${part.image.id}]`,
    )
    .join("\n");
}

/**
 * Function a caller supplies to estimate the token count of a string. Kept
 * intentionally tiny so `@covel/context` stays free of runtime deps on any
 * tokenizer package.
 */
export type TokenEstimator = (text: string) => number;

/**
 * CJK ranges: radicals/kana/ideographs (2E80–9FFF), Hangul syllables
 * (AC00–D7AF), compatibility ideographs (F900–FAFF), fullwidth forms
 * (FF00–FFEF).
 */
const CJK_RE = /[⺀-鿿가-힯豈-﫿＀-￯]/g;

/**
 * Default character-heuristic token estimator, CJK-aware.
 *
 * The naive `chars / 4` rule undercounts CJK text ~3× (CJK runs at roughly
 * 1–1.7 characters per token across common tokenizers), which let Chinese
 * sessions blow past the real model window long before the estimate tripped
 * any threshold. Count CJK characters at 1 token each (deliberately on the
 * high side — overestimating triggers compaction early, which is the safe
 * direction) and everything else at 4 chars per token.
 */
export function estimateTokens(text: string): number {
  const cjkCount = text.match(CJK_RE)?.length ?? 0;
  return cjkCount + Math.ceil((text.length - cjkCount) / 4);
}

/** Configuration for a single {@link applyBudget} call. */
export interface BudgetOptions {
  /**
   * Hard upper bound on the number of input tokens the LLM call may consume.
   * Typically derived from the slot's contextWindow. The caller is
   * responsible for choosing this value; budget.ts does no slot lookup.
   */
  readonly maxInputTokens: number;
  /**
   * Tokens to reserve for the model's response (subtracted from the budget
   * before pruning decisions). Default 4000.
   */
  readonly reservedForResponse?: number;
  /**
   * Number of trailing user messages (plus everything after them) that must
   * never be pruned. Protects the current conversational context. Default 1.
   * Older turns remain available through compacted-history envelopes; keeping
   * two raw user turns here can make the summary + protected tail impossible
   * to fit in small context windows.
   */
  readonly protectLastUserTurns?: number;
  /** Token estimator injected by the caller. */
  readonly estimator: TokenEstimator;
}

/** Result of a {@link applyBudget} call. */
export interface BudgetResult<M> {
  /** The (possibly pruned) messages. */
  readonly messages: readonly M[];
  /** Estimated total tokens for systemPrompt + kept messages (post-prune). */
  readonly totalTokens: number;
  /** How many messages were dropped (not counting the placeholder). */
  readonly prunedMessageCount: number;
  /** Whether pruning had to be triggered. */
  readonly budgetExceeded: boolean;
}

const DEFAULT_RESERVED_FOR_RESPONSE = 4000;
const DEFAULT_PROTECT_LAST_USER_TURNS = 1;

/** Normalized numeric limits shared by prompt assembly and runtime calls. */
export interface ResolvedBudgetOptions {
  readonly maxInputTokens: number;
  readonly reservedForResponse: number;
  readonly protectLastUserTurns: number;
}

/**
 * Validate and normalize a budget before it is used for pruning or as a
 * provider output limit. Invalid limits are configuration errors: silently
 * returning an over-budget request only defers the failure to the provider.
 */
export function resolveBudgetOptions(
  options: Omit<BudgetOptions, "estimator">,
): ResolvedBudgetOptions {
  const maxInputTokens = options.maxInputTokens;
  const reservedForResponse =
    options.reservedForResponse ?? DEFAULT_RESERVED_FOR_RESPONSE;
  const protectLastUserTurns =
    options.protectLastUserTurns ?? DEFAULT_PROTECT_LAST_USER_TURNS;

  if (!Number.isInteger(maxInputTokens) || maxInputTokens <= 0) {
    throw new RangeError(
      `maxInputTokens must be a positive integer; received ${String(maxInputTokens)}`,
    );
  }
  if (
    !Number.isInteger(reservedForResponse) ||
    reservedForResponse < 0 ||
    reservedForResponse >= maxInputTokens
  ) {
    throw new RangeError(
      `reservedForResponse must be a non-negative integer smaller than maxInputTokens (${maxInputTokens}); received ${String(reservedForResponse)}`,
    );
  }
  if (!Number.isInteger(protectLastUserTurns) || protectLastUserTurns < 0) {
    throw new RangeError(
      `protectLastUserTurns must be a non-negative integer; received ${String(protectLastUserTurns)}`,
    );
  }

  return { maxInputTokens, reservedForResponse, protectLastUserTurns };
}

function estimateMessageTokens<
  M extends {
    readonly role: string;
    readonly content: string | readonly ContentPart[];
  },
>(message: M, estimator: TokenEstimator): number {
  const extended = message as M & {
    readonly name?: string;
    readonly toolCallId?: string;
    readonly toolCalls?: unknown;
    readonly reasoningContent?: string;
  };
  const auxiliary = {
    ...(extended.name ? { name: extended.name } : {}),
    ...(extended.toolCallId ? { toolCallId: extended.toolCallId } : {}),
    ...(extended.toolCalls ? { toolCalls: extended.toolCalls } : {}),
    ...(extended.reasoningContent
      ? { reasoningContent: extended.reasoningContent }
      : {}),
  };
  return (
    estimator(flattenContent(message.content)) +
    (Object.keys(auxiliary).length > 0
      ? estimator(JSON.stringify(auxiliary))
      : 0)
  );
}

function isCompactedHistoryEnvelope(message: {
  readonly content: string | readonly ContentPart[];
}): boolean {
  return (
    typeof message.content === "string" &&
    message.content.trimStart().startsWith("<compacted_history>\n")
  );
}

/**
 * Walk backwards through the message list and compute the index at which
 * the protect window starts. `messages.slice(protectStartIndex)` is
 * guaranteed to be preserved under all circumstances.
 *
 * Stops immediately AFTER encountering the Nth user message from the tail,
 * so that user message (and everything strictly after it) is protected.
 * When there are fewer user messages than `protectLastUserTurns`, the
 * protect window is the entire list.
 */
function computeProtectStartIndex(
  messages: readonly { readonly role: string }[],
  protectLastUserTurns: number,
): number {
  if (protectLastUserTurns <= 0 || messages.length === 0) {
    return messages.length;
  }
  let userSeen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") {
      userSeen += 1;
      if (userSeen >= protectLastUserTurns) {
        return i;
      }
    }
  }
  // Fewer user messages than requested → protect the entire list.
  return 0;
}

/**
 * Pure pruning pass. Given a system prompt and an ordered message list,
 * drop the OLDEST messages that are outside the protect window until the
 * estimated total fits within `(maxInputTokens - reservedForResponse)`.
 * If anything is pruned, a single synthetic placeholder system message is
 * inserted at the start of the remaining list.
 *
 * Messages in the protect window are never dropped — even if the budget
 * still can't be satisfied. In that case `budgetExceeded: true` is returned
 * and the protected tail is left intact (the caller decides how to react).
 */
export function applyBudget<
  M extends {
    readonly role: string;
    readonly content: string | readonly ContentPart[];
  },
>(
  systemPrompt: string,
  messages: readonly M[],
  options: BudgetOptions,
): BudgetResult<M> {
  const { estimator } = options;
  const { maxInputTokens, reservedForResponse, protectLastUserTurns } =
    resolveBudgetOptions(options);

  const systemTokens = estimator(systemPrompt);
  const budgetCap = maxInputTokens - reservedForResponse;

  const messageTokens: number[] = messages.map((m) =>
    estimateMessageTokens(m, estimator),
  );
  const messageTokensSum = messageTokens.reduce((acc, n) => acc + n, 0);
  let total = systemTokens + messageTokensSum;

  // Happy path: fits without any pruning.
  if (total <= budgetCap) {
    return {
      messages,
      totalTokens: total,
      prunedMessageCount: 0,
      budgetExceeded: false,
    };
  }

  // Compute the protect window boundary. Everything at/after this index
  // must survive; everything before it is pruneable (left-to-right).
  const protectStartIndex = computeProtectStartIndex(
    messages,
    protectLastUserTurns,
  );

  let prunedMessageCount = 0;
  const prunedIndices = new Set<number>();

  // Summaries are the only surviving representation of already-compacted raw
  // history. Preserve every envelope ahead of raw messages so a hard-prune
  // pass cannot immediately erase the records the compactor just persisted.
  // If the summaries plus protected tail cannot fit, callers receive an
  // over-cap total and must stop before issuing the provider request.
  const preservedSummaryIndices = new Set<number>();
  for (let i = 0; i < protectStartIndex; i++) {
    if (isCompactedHistoryEnvelope(messages[i]!)) {
      preservedSummaryIndices.add(i);
    }
  }

  let pruneCursor = 0;
  const pruneNext = (): boolean => {
    while (
      pruneCursor < protectStartIndex &&
      preservedSummaryIndices.has(pruneCursor)
    ) {
      pruneCursor += 1;
    }
    if (pruneCursor >= protectStartIndex) return false;
    total -= messageTokens[pruneCursor]!;
    prunedIndices.add(pruneCursor);
    pruneCursor += 1;
    prunedMessageCount += 1;
    return true;
  };

  // Drain the pruneable prefix from the left until we fit or run out.
  while (total > budgetCap && pruneNext()) {
    // Continue until the request fits or only the preserved summary and
    // protected tail remain.
  }

  // Tool-pair integrity: a `tool` message is only valid when the assistant
  // message that requested it is still present — its `tool_call_id` points
  // there, and providers reject a transcript that starts with an orphan.
  // Cutting the prefix can land mid-pair, so drop any leading tool messages
  // the cut orphaned. Without this the whole pruning pass was unusable for
  // tool-declaring runtimes (i.e. every main agent), which is why they were
  // excluded from hard budget enforcement entirely.
  const pruneOrphanedLeadingTools = (): void => {
    while (
      pruneCursor < messages.length &&
      prunedMessageCount > 0 &&
      messages[pruneCursor]!.role === "tool"
    ) {
      if (!prunedIndices.has(pruneCursor)) {
        total -= messageTokens[pruneCursor]!;
        prunedIndices.add(pruneCursor);
        prunedMessageCount += 1;
      }
      pruneCursor += 1;
    }
  };
  pruneOrphanedLeadingTools();

  // Nothing was actually prunable (protectLastUserTurns covered everything).
  if (prunedMessageCount === 0) {
    return {
      messages,
      totalTokens: total,
      prunedMessageCount: 0,
      budgetExceeded: true,
    };
  }

  let placeholderContent = `[... ${prunedMessageCount} older messages pruned to stay within token budget ...]`;
  let placeholderTokens = estimator(placeholderContent);

  // The marker is part of the real request. Continue pruning if it is the
  // difference between fitting and overflowing; previous behaviour tolerated
  // this overshoot, which violates a hard context-window contract.
  while (total + placeholderTokens > budgetCap && pruneNext()) {
    placeholderContent = `[... ${prunedMessageCount} older messages pruned to stay within token budget ...]`;
    placeholderTokens = estimator(placeholderContent);
  }
  pruneOrphanedLeadingTools();
  placeholderContent = `[... ${prunedMessageCount} older messages pruned to stay within token budget ...]`;
  placeholderTokens = estimator(placeholderContent);

  const survivors = messages.filter((_, index) => !prunedIndices.has(index));
  // The placeholder is a synthetic message matching the caller's message
  // shape. The `as unknown as M` cast is unavoidable: `M` is a generic
  // constrained only to `{ role; content }`, so TypeScript can't prove a
  // plain `{ role, content }` literal covers arbitrary extensions of `M`.
  // This is the only escape hatch in the module and is intentional.
  const placeholder = {
    role: "system",
    content: placeholderContent,
  } as unknown as M;

  // Placeholder counts against the budget so callers can reject the request
  // when the protected content plus marker still cannot fit.
  total += placeholderTokens;

  return {
    messages: [placeholder, ...survivors],
    totalTokens: total,
    prunedMessageCount,
    budgetExceeded: true,
  };
}
