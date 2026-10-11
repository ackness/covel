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

import { instructionLocaleFor, type LLMContentPart } from "@covel/shared";

/**
 * Tokens one image is counted as. Providers charge by pixel area: about 770
 * tokens for a 1024x1024 picture on OpenAI at high detail, about 1,400 on
 * Anthropic, and up to 1,600 for the largest size either accepts unscaled.
 */
export const IMAGE_PART_TOKEN_ESTIMATE = 1_500;

/**
 * Convert a message `content` value (string or content-part array) into the
 * flat text the estimator can consume. An image contributes a fixed marker;
 * its cost is added per part by the budget (`IMAGE_PART_TOKEN_ESTIMATE`).
 */
export function flattenMessageContent(
  content: string | readonly LLMContentPart[],
): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? part.text : "[image]"))
    .join("\n");
}

/**
 * Function a caller supplies to estimate the token count of a string. Kept
 * intentionally tiny so `@covel/context` stays free of runtime deps on any
 * tokenizer package.
 */
import type { TokenEstimator } from "@covel/plugin-handlers-utils";
export type { TokenEstimator } from "@covel/plugin-handlers-utils";

export { estimateTokens } from "@covel/shared";

/** Configuration for a single {@link applyBudget} call. */
export interface BudgetOptions {
  /**
   * Hard upper bound on the number of input tokens the LLM call may consume.
   * Typically derived from the slot's contextWindow. The caller is
   * responsible for choosing this value; budget.ts does no slot lookup.
   */
  readonly maxInputTokens: number;
  /** Explicit deployment ceiling retained when resolving a model's window. */
  readonly contextWindowLimit?: number;
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
  /** Session locale; the pruned-messages marker is in its instruction language. */
  readonly locale?: string;
}

/**
 * The message that stands in for the pruned ones. It does not say how many
 * were pruned: the number changed whenever the cut moved, and with it the
 * first message of every request.
 */
function prunedMarker(locale: string | undefined): string {
  return instructionLocaleFor(locale) === "zh"
    ? "[... 为了不超出 token 预算，已裁掉较早的消息 ...]"
    : "[... older messages pruned to stay within token budget ...]";
}

/**
 * Share of the input cap that one pruning step removes.
 *
 * Pruning starts again from the full history at every request. Dropping only
 * what did not fit moved the first kept message at every turn, so no request
 * matched the one before it past the system prompt, and a provider's prefix
 * cache never reached the history. Whole steps are dropped instead: the
 * request is cut to about 70% of the cap, and the cut stays where it is until
 * the history has grown by another step.
 */
const PRUNE_STEP_RATIO = 0.3;

/** Result of a {@link applyBudget} call. */
export interface BudgetResult<M> {
  /** The (possibly pruned) messages. */
  readonly messages: readonly M[];
  /** Estimated total tokens for systemPrompt + kept messages (post-prune). */
  readonly totalTokens: number;
  /** How many messages were dropped (not counting the placeholder). */
  readonly prunedMessageCount: number;
  /**
   * The request is still over the cap: nothing more could be dropped. A
   * request that was pruned and now fits has `overBudget: false` and
   * `prunedMessageCount > 0`.
   */
  readonly overBudget: boolean;
}

const DEFAULT_RESERVED_FOR_RESPONSE = 4000;
export const DEFAULT_PROTECT_LAST_USER_TURNS = 1;

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
    readonly content: string | readonly LLMContentPart[];
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
  const images = Array.isArray(message.content)
    ? message.content.filter((part) => part.type !== "text").length
    : 0;
  return (
    estimator(flattenMessageContent(message.content)) +
    images * IMAGE_PART_TOKEN_ESTIMATE +
    (Object.keys(auxiliary).length > 0
      ? estimator(JSON.stringify(auxiliary))
      : 0)
  );
}

/** Whether a message is the envelope a compaction summary is sent in. */
export function isCompactedHistoryEnvelope(message: {
  readonly content: string | readonly LLMContentPart[];
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
 * System messages directly ahead of it are protected with it: they are that
 * turn's context (the turn context message, a note placed before the turn),
 * and a request that keeps the turn without them answers it blind.
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
        let start = i;
        while (start > 0 && messages[start - 1]!.role === "system") start--;
        return start;
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
 * Messages go in whole steps of the cap (see `PRUNE_STEP_RATIO`), so the
 * list that is kept starts at the same message for several turns.
 * If anything is pruned, a single synthetic placeholder system message is
 * inserted at the start of the remaining list.
 *
 * Messages in the protect window are never dropped — even if the budget
 * still can't be satisfied. In that case `overBudget: true` is returned
 * and the protected tail is left intact (the caller decides how to react).
 */
export function applyBudget<
  M extends {
    readonly role: string;
    readonly content: string | readonly LLMContentPart[];
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
      overBudget: false,
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

  // The marker is part of the real request, so the kept messages must leave
  // room for it. What has to go is rounded up to whole steps: the amount, and
  // with it the first kept message, changes only when the history has grown
  // by a step, not at every turn.
  const placeholderContent = prunedMarker(options.locale);
  const placeholderTokens = estimator(placeholderContent);
  const pruneStep = Math.max(1, Math.floor(budgetCap * PRUNE_STEP_RATIO));
  const pruneTarget =
    Math.ceil((total + placeholderTokens - budgetCap) / pruneStep) * pruneStep;
  const unprunedTotal = total;

  // Drain the pruneable prefix from the left until the target is met or only
  // the preserved summaries and the protected tail remain.
  while (unprunedTotal - total < pruneTarget && pruneNext()) {
    // pruneNext does the work.
  }

  // Tool-pair integrity: a `tool` message is only valid when the assistant
  // message that requested it is still present — its `tool_call_id` points
  // there, and providers reject a transcript that starts with an orphan.
  // Cutting the prefix can land mid-pair, so drop any leading tool messages
  // the cut orphaned. Without this the whole pruning pass was unusable for
  // tool-declaring runtimes (i.e. every main agent), which is why they were
  // excluded from hard budget enforcement entirely.
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

  // Nothing was actually prunable (protectLastUserTurns covered everything).
  if (prunedMessageCount === 0) {
    return {
      messages,
      totalTokens: total,
      prunedMessageCount: 0,
      overBudget: true,
    };
  }

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
    overBudget: total > budgetCap,
  };
}
