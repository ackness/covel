/**
 * Token budget + message pruning (S1-T2).
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
   * never be pruned. Protects recent conversational context. Default 2.
   * Matches OpenCode's "protect last 2 user turns" rule.
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
const DEFAULT_PROTECT_LAST_USER_TURNS = 2;

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
  const {
    maxInputTokens,
    reservedForResponse = DEFAULT_RESERVED_FOR_RESPONSE,
    protectLastUserTurns = DEFAULT_PROTECT_LAST_USER_TURNS,
    estimator,
  } = options;

  const systemTokens = estimator(systemPrompt);
  const budgetCap = maxInputTokens - reservedForResponse;

  // Caller misconfiguration — nothing sensible we can do.
  if (budgetCap <= 0) {
    return {
      messages,
      totalTokens: systemTokens,
      prunedMessageCount: 0,
      budgetExceeded: true,
    };
  }

  const messageTokens: number[] = messages.map((m) =>
    estimator(flattenContent(m.content)),
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
  let firstSurvivorIndex = 0;

  // Drain the pruneable prefix from the left until we fit or run out.
  while (firstSurvivorIndex < protectStartIndex && total > budgetCap) {
    total -= messageTokens[firstSurvivorIndex]!;
    firstSurvivorIndex += 1;
    prunedMessageCount += 1;
  }

  // Tool-pair integrity: a `tool` message is only valid when the assistant
  // message that requested it is still present — its `tool_call_id` points
  // there, and providers reject a transcript that starts with an orphan.
  // Cutting the prefix can land mid-pair, so drop any leading tool messages
  // the cut orphaned. Without this the whole pruning pass was unusable for
  // tool-declaring runtimes (i.e. every main agent), which is why they were
  // excluded from hard budget enforcement entirely.
  while (
    firstSurvivorIndex < messages.length &&
    prunedMessageCount > 0 &&
    messages[firstSurvivorIndex]!.role === "tool"
  ) {
    total -= messageTokens[firstSurvivorIndex]!;
    firstSurvivorIndex += 1;
    prunedMessageCount += 1;
  }

  // Nothing was actually prunable (protectLastUserTurns covered everything).
  if (prunedMessageCount === 0) {
    return {
      messages,
      totalTokens: total,
      prunedMessageCount: 0,
      budgetExceeded: true,
    };
  }

  const survivors = messages.slice(firstSurvivorIndex);
  const placeholderContent = `[... ${prunedMessageCount} older messages pruned to stay within token budget ...]`;
  // The placeholder is a synthetic message matching the caller's message
  // shape. The `as unknown as M` cast is unavoidable: `M` is a generic
  // constrained only to `{ role; content }`, so TypeScript can't prove a
  // plain `{ role, content }` literal covers arbitrary extensions of `M`.
  // This is the only escape hatch in the module and is intentional.
  const placeholder = {
    role: "system",
    content: placeholderContent,
  } as unknown as M;

  // Placeholder counts against the budget so the caller sees a realistic
  // figure. A small overshoot here is acceptable — one system message of
  // ~30 characters won't meaningfully blow the budget.
  total += estimator(placeholderContent);

  return {
    messages: [placeholder, ...survivors],
    totalTokens: total,
    prunedMessageCount,
    budgetExceeded: true,
  };
}
