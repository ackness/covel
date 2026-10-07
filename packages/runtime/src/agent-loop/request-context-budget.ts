import {
  applyBudget,
  flattenMessageContent,
  isCompactedHistoryEnvelope,
  resolveBudgetOptions,
  type TokenEstimator,
  type BudgetOptions,
} from "@covel/context";
import {
  instructionLocaleFor,
  resolveLlmTokenLimits,
  type LLMAdapter,
} from "@covel/shared";
import type {
  LLMMessage,
  LLMResponseFormat,
  LLMToolDefinition,
} from "../llm/llm-adapter.js";
import type { RetryPolicy } from "../retry/llm-retry.js";
import { retryHint } from "../retry/retry-common.js";

import type { TurnEmitter } from "../trace/turn-emitter.js";

/** Reserve the requested output before pruning the final provider request. */
export function resolveRequestContextBudget(
  base: Omit<BudgetOptions, "estimator">,
  llm: LLMAdapter,
  slot: string | undefined,
): Omit<BudgetOptions, "estimator"> {
  const target = llm.resolveBudget?.(slot);
  const limits = resolveLlmTokenLimits({
    contextWindow: Math.min(
      target?.contextWindow ?? base.maxInputTokens,
      base.contextWindowLimit ?? Infinity,
    ),
    maxOutputTokens: target?.maxOutputTokens,
    requestedMaxOutputTokens: target?.requestedMaxOutputTokens,
    defaultMaxOutputTokens: base.reservedForResponse,
  });
  return {
    ...base,
    ...resolveBudgetOptions({
      ...base,
      maxInputTokens: limits.contextWindow,
      reservedForResponse: limits.maxOutputTokens,
    }),
  };
}

export function applyPerCallBudget(params: {
  readonly llm: LLMAdapter;
  readonly slot: string | undefined;
  readonly runtimeId: string;
  readonly messages: readonly LLMMessage[];
  readonly tools: readonly LLMToolDefinition[] | undefined;
  readonly responseFormat: LLMResponseFormat | undefined;
  readonly retryPolicy: RetryPolicy;
  readonly estimator: TokenEstimator;
  readonly contextBudget: Omit<BudgetOptions, "estimator">;
  /** Session locale: the markers this adds are in its instruction language. */
  readonly locale?: string;
}): {
  readonly messages: LLMMessage[];
  readonly prunedMessageCount: number;
  readonly truncatedToolResultCount: number;
  readonly truncatedSummaryCount: number;
  readonly maxOutputTokens: number;
} {
  try {
    return budgetProviderRequest({
      ...params,
      contextBudget: resolveRequestContextBudget(
        params.contextBudget,
        params.llm,
        params.slot,
      ),
    });
  } catch (error) {
    let target;
    try {
      target = params.llm.resolveTarget?.(params.slot);
    } catch {
      /* Keep the budget error. */
    }
    const identity = target
      ? `provider: ${target.provider}, model: ${target.model}, `
      : "";
    const message = error instanceof Error ? error.message : String(error);
    throw new RangeError(
      `[${identity}slot: ${params.slot ?? "default"}] ${message}`,
      { cause: error },
    );
  }
}

function budgetProviderRequest(
  params: Parameters<typeof applyPerCallBudget>[0],
) {
  const limits = resolveBudgetOptions(params.contextBudget);
  const [first, ...rest] = params.messages;
  const hasPrimarySystem = first?.role === "system";
  const primarySystem = hasPrimarySystem ? first : undefined;
  const primarySystemText = primarySystem
    ? flattenMessageContent(primarySystem.content)
    : "";
  const toolDefinitionsText =
    params.tools && params.tools.length > 0
      ? `<tool_definitions>${JSON.stringify(params.tools)}</tool_definitions>`
      : "";
  const responseFormatText = params.responseFormat
    ? `<response_format>${JSON.stringify(params.responseFormat)}</response_format>`
    : "";
  // The longest hint a retry can append, so a retried call still fits.
  const retryText =
    params.retryPolicy.maxRetries > 0
      ? retryHint(
          params.retryPolicy.maxRetries,
          "tool-loop-detected",
          params.locale,
        )
      : "";
  const fixedInput = [
    primarySystemText,
    toolDefinitionsText,
    responseFormatText,
    retryText,
  ]
    .filter(Boolean)
    .join("\n");
  const budgeted = applyBudget(
    fixedInput,
    hasPrimarySystem ? rest : params.messages,
    {
      ...params.contextBudget,
      estimator: params.estimator,
      locale: params.locale,
    },
  );
  const fixedInputTokens = params.estimator(fixedInput);
  const systemTokens = params.estimator(primarySystemText);
  const toolDefinitionTokens = params.estimator(toolDefinitionsText);
  const responseFormatTokens = params.estimator(responseFormatText);
  const inputLimit = limits.maxInputTokens - limits.reservedForResponse;
  const overflow = Math.max(0, budgeted.totalTokens - inputLimit);
  const zh = instructionLocaleFor(params.locale) === "zh";
  // Tool messages after the current user turn cannot be removed without
  // breaking provider tool-call pairing. When a read tool returns more data
  // than the next call can carry, a marked head/tail preview stays in the
  // request; the full parsed result remains in RuntimeResult.toolCalls and
  // traces.
  const compacted = truncateMessagesToFit(
    budgeted.messages,
    overflow,
    params.estimator,
    zh ? TOOL_RESULT_TRUNCATION_MARKER.zh : TOOL_RESULT_TRUNCATION_MARKER.en,
    (message) => message.role === "tool",
  );
  const afterToolResults = budgeted.totalTokens - compacted.savedTokens;
  const compactedSummaries = truncateMessagesToFit(
    compacted.messages,
    Math.max(0, afterToolResults - inputLimit),
    params.estimator,
    zh ? SUMMARY_TRUNCATION_MARKER.zh : SUMMARY_TRUNCATION_MARKER.en,
    isCompactedHistoryEnvelope,
  );
  const compactedTotal = afterToolResults - compactedSummaries.savedTokens;
  if (compactedTotal > inputLimit) {
    throw new RangeError(
      `Context budget exceeded before LLM call for runtime "${params.runtimeId}": estimated ${compactedTotal} input tokens, limit ${inputLimit} (fixed=${fixedInputTokens}, system=${systemTokens}, tools=${toolDefinitionTokens}, responseFormat=${responseFormatTokens}, messages=${budgeted.totalTokens - fixedInputTokens}, toolResultSaved=${compacted.savedTokens}, summarySaved=${compactedSummaries.savedTokens})`,
    );
  }
  return {
    messages: [
      ...(primarySystem ? [primarySystem] : []),
      ...compactedSummaries.messages,
    ],
    prunedMessageCount: budgeted.prunedMessageCount,
    truncatedToolResultCount: compacted.truncatedCount,
    truncatedSummaryCount: compactedSummaries.truncatedCount,
    maxOutputTokens: limits.reservedForResponse,
  };
}

const TOOL_RESULT_TRUNCATION_MARKER = {
  en: "\n...[tool result truncated; query a narrower scope if needed]...\n",
  zh: "\n...[工具结果已截断；需要时查询更小的范围]...\n",
};
const SUMMARY_TRUNCATION_MARKER = {
  en: "\n...[compacted history truncated; durable copy unchanged]...\n",
  zh: "\n...[压缩历史已截断；持久保存的副本没有变]...\n",
};

/**
 * Shorten the text messages `eligible` selects until `tokensToSave` tokens
 * are saved. A shortened message keeps a marked head and tail.
 */
function truncateMessagesToFit(
  messages: readonly LLMMessage[],
  tokensToSave: number,
  estimator: TokenEstimator,
  marker: string,
  eligible: (message: LLMMessage) => boolean,
): {
  readonly messages: LLMMessage[];
  readonly savedTokens: number;
  readonly truncatedCount: number;
} {
  if (tokensToSave <= 0) {
    return { messages: [...messages], savedTokens: 0, truncatedCount: 0 };
  }

  const compacted = [...messages];
  let remaining = tokensToSave;
  let savedTokens = 0;
  let truncatedCount = 0;

  // The oldest message loses detail first; of several tool results the most
  // recent is usually the one the model requested to refine an earlier,
  // broader lookup.
  for (let index = 0; index < compacted.length && remaining > 0; index += 1) {
    const message = compacted[index]!;
    if (typeof message.content !== "string" || !eligible(message)) continue;
    const originalTokens = estimator(message.content);
    const minimumTokens = estimator(marker);
    if (originalTokens <= minimumTokens) continue;

    // Keep a small safety token because heuristic estimators and integer
    // boundaries are not perfectly linear under head/tail truncation.
    const targetTokens = Math.max(
      minimumTokens,
      originalTokens - remaining - 1,
    );
    const content = truncateContentHeadTail(
      message.content,
      targetTokens,
      estimator,
      marker,
    );
    const newTokens = estimator(content);
    const saved = Math.max(0, originalTokens - newTokens);
    if (saved === 0) continue;

    compacted[index] = { ...message, content };
    savedTokens += saved;
    remaining = Math.max(0, remaining - saved);
    truncatedCount += 1;
  }

  return { messages: compacted, savedTokens, truncatedCount };
}

function truncateContentHeadTail(
  content: string,
  maxTokens: number,
  estimator: TokenEstimator,
  marker: string,
): string {
  if (estimator(content) <= maxTokens) return content;
  if (estimator(marker) >= maxTokens) {
    return marker.trim();
  }

  let low = 0;
  let high = content.length;
  let best = marker;
  while (low <= high) {
    const keepChars = Math.floor((low + high) / 2);
    const headChars = Math.ceil(keepChars / 2);
    const tailChars = Math.floor(keepChars / 2);
    const candidate =
      content.slice(0, headChars) +
      marker +
      (tailChars > 0 ? content.slice(-tailChars) : "");
    if (estimator(candidate) <= maxTokens) {
      best = candidate;
      low = keepChars + 1;
    } else {
      high = keepChars - 1;
    }
  }
  return best;
}

/** Budget the final request and report pruning through the turn's trace. */
export async function prepareBudgetedRequest(
  params: Omit<
    Parameters<typeof applyPerCallBudget>[0],
    "estimator" | "contextBudget"
  > & {
    readonly estimator?: TokenEstimator;
    readonly contextBudget?: Omit<BudgetOptions, "estimator">;
    readonly pluginId: string;
    readonly emitter?: TurnEmitter;
  },
) {
  if (!params.estimator || !params.contextBudget) return undefined;
  const budgeted = applyPerCallBudget({
    ...params,
    estimator: params.estimator,
    contextBudget: params.contextBudget,
  });
  if (
    budgeted.prunedMessageCount > 0 ||
    budgeted.truncatedToolResultCount > 0 ||
    budgeted.truncatedSummaryCount > 0
  ) {
    await params.emitter?.emit("context.pruned", {
      runtimeId: params.runtimeId,
      pluginId: params.pluginId,
      prunedMessageCount: budgeted.prunedMessageCount,
      truncatedToolResultCount: budgeted.truncatedToolResultCount,
      truncatedSummaryCount: budgeted.truncatedSummaryCount,
    });
  }
  return budgeted;
}
