import {
  applyBudget,
  resolveBudgetOptions,
  type BudgetOptions,
  type TokenEstimator,
} from "@covel/context";
import type {
  LLMMessage,
  LLMResponseFormat,
  LLMToolDefinition,
} from "../llm/llm-adapter.js";
import type { RetryPolicy } from "../retry/llm-retry.js";

function contentForBudget(content: LLMMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) =>
      part.type === "text" ? part.text : `[image:${part.image.id}]`,
    )
    .join("\n");
}

export function applyPerCallBudget(params: {
  readonly runtimeId: string;
  readonly messages: readonly LLMMessage[];
  readonly tools: readonly LLMToolDefinition[] | undefined;
  readonly responseFormat: LLMResponseFormat | undefined;
  readonly retryPolicy: RetryPolicy;
  readonly estimator: TokenEstimator;
  readonly contextBudget: Omit<BudgetOptions, "estimator">;
}): {
  readonly messages: LLMMessage[];
  readonly prunedMessageCount: number;
  readonly truncatedToolResultCount: number;
  readonly truncatedSummaryCount: number;
  readonly maxOutputTokens: number;
} {
  const limits = resolveBudgetOptions(params.contextBudget);
  const [first, ...rest] = params.messages;
  const hasPrimarySystem = first?.role === "system";
  const primarySystem = hasPrimarySystem ? first : undefined;
  const primarySystemText = primarySystem
    ? contentForBudget(primarySystem.content)
    : "";
  const toolDefinitionsText =
    params.tools && params.tools.length > 0
      ? `<tool_definitions>${JSON.stringify(params.tools)}</tool_definitions>`
      : "";
  const responseFormatText = params.responseFormat
    ? `<response_format>${JSON.stringify(params.responseFormat)}</response_format>`
    : "";
  const retryText =
    params.retryPolicy.maxRetries > 0
      ? `[retry ${params.retryPolicy.maxRetries}] The previous attempt called the same tool repeatedly. Vary your approach or finish with runtime-done.${" ".repeat(params.retryPolicy.maxRetries)}`
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
    { ...params.contextBudget, estimator: params.estimator },
  );
  const fixedInputTokens = params.estimator(fixedInput);
  const systemTokens = params.estimator(primarySystemText);
  const toolDefinitionTokens = params.estimator(toolDefinitionsText);
  const responseFormatTokens = params.estimator(responseFormatText);
  const inputLimit = limits.maxInputTokens - limits.reservedForResponse;
  const overflow = Math.max(0, budgeted.totalTokens - inputLimit);
  const compacted = compactToolResultsToFit(
    budgeted.messages,
    overflow,
    params.estimator,
  );
  const afterToolResults = budgeted.totalTokens - compacted.savedTokens;
  const compactedSummaries = compactSummaryEnvelopesToFit(
    compacted.messages,
    Math.max(0, afterToolResults - inputLimit),
    params.estimator,
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

const TOOL_RESULT_TRUNCATION_MARKER =
  "\n...[tool result truncated; query a narrower scope if needed]...\n";
const SUMMARY_TRUNCATION_MARKER =
  "\n...[compacted history truncated; durable copy unchanged]...\n";

/**
 * Tool messages after the current user turn cannot be removed without
 * breaking provider tool-call pairing. When a read tool returns more data
 * than the next call can carry, retain a marked head/tail preview while the
 * full parsed result remains available in RuntimeResult.toolCalls and traces.
 */
function compactToolResultsToFit(
  messages: readonly LLMMessage[],
  tokensToSave: number,
  estimator: TokenEstimator,
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

  // Oldest tool results lose detail first; the most recent result is usually
  // the one the model requested to refine an earlier, broader lookup.
  for (let index = 0; index < compacted.length && remaining > 0; index += 1) {
    const message = compacted[index]!;
    if (message.role !== "tool" || typeof message.content !== "string") {
      continue;
    }
    const originalTokens = estimator(message.content);
    const minimumTokens = estimator(TOOL_RESULT_TRUNCATION_MARKER);
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
      TOOL_RESULT_TRUNCATION_MARKER,
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

function compactSummaryEnvelopesToFit(
  messages: readonly LLMMessage[],
  tokensToSave: number,
  estimator: TokenEstimator,
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
  for (let index = 0; index < compacted.length && remaining > 0; index += 1) {
    const message = compacted[index]!;
    if (
      typeof message.content !== "string" ||
      !message.content.trimStart().startsWith("<compacted_history>\n")
    ) {
      continue;
    }
    const originalTokens = estimator(message.content);
    const minimumTokens = estimator(SUMMARY_TRUNCATION_MARKER);
    if (originalTokens <= minimumTokens) continue;
    const targetTokens = Math.max(
      minimumTokens,
      originalTokens - remaining - 1,
    );
    const content = truncateContentHeadTail(
      message.content,
      targetTokens,
      estimator,
      SUMMARY_TRUNCATION_MARKER,
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
