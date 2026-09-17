import { resolveRequestContextBudget, type LLMAdapter } from "@covel/runtime";
import { resolveLlmTokenLimits } from "@covel/shared";
import type { DataStore } from "@covel/store";
import {
  estimateTokens,
  maybeCompact,
  type BudgetOptions,
  type CompactorLLMAdapter,
  type CompactorRunner,
} from "@covel/context";
import type { ParsedPluginMd } from "@covel/plugin-loader";

interface BudgetSourceParams {
  /** Explicit deployment ceiling, independent of other configured models. */
  readonly contextWindowOverride?: number;
}

export interface CreateBootstrapCompactorRunnerParams extends BudgetSourceParams {
  readonly manifestCache: ReadonlyMap<string, readonly ParsedPluginMd[]>;
  readonly store: DataStore;
  readonly llmAdapter: LLMAdapter;
}

export function createBootstrapCompactorRunner(
  params: CreateBootstrapCompactorRunnerParams,
): CompactorRunner {
  const { manifestCache, store, llmAdapter } = params;
  const allSummaryFocus = new Set<string>();
  for (const [, manifests] of manifestCache) {
    for (const parsed of manifests) {
      for (const section of parsed.manifest.summaryFocus ?? []) {
        allSummaryFocus.add(section);
      }
    }
  }
  const focusSections: readonly string[] = [...allSummaryFocus];

  return {
    async run(sessionId, systemPromptPreview, messages, locale, traceId) {
      // Resolve once per run so a hot reload cannot make the threshold use one
      // capability while the provider call uses another. Compaction input and
      // output share the same model context, so only the window left after the
      // response reserve is available to the compactor prompt.
      const budget = resolveRequestContextBudget(
        createTurnContextBudget(params),
        llmAdapter,
        "fast",
      );
      const fastSlotLlm: CompactorLLMAdapter = {
        async complete(input) {
          const response = await llmAdapter.generate({
            model: "fast",
            maxOutputTokens: budget.reservedForResponse,
            messages: [
              { role: "system", content: input.systemPrompt },
              ...input.messages.map((m) => ({
                role: m.role as "user",
                content: m.content,
              })),
            ],
          });
          return { content: response.content ?? "" };
        },
      };
      return await maybeCompact(
        sessionId,
        systemPromptPreview,
        messages,
        {
          store,
          estimator: estimateTokens,
          fastSlotLlm,
          contextWindow:
            budget.maxInputTokens - (budget.reservedForResponse ?? 0),
        },
        {
          focusSections,
          ...(locale ? { locale } : {}),
          ...(traceId ? { traceId } : {}),
        },
      );
    },
  };
}

/** Fallback limits; each call replaces these with its actual model budget. */
export function createTurnContextBudget(
  params: BudgetSourceParams,
): Omit<BudgetOptions, "estimator"> {
  const limits = resolveLlmTokenLimits({
    contextWindow: params.contextWindowOverride,
  });
  return {
    maxInputTokens: limits.contextWindow,
    reservedForResponse: limits.maxOutputTokens,
    ...(params.contextWindowOverride !== undefined
      ? { contextWindowLimit: params.contextWindowOverride }
      : {}),
  };
}
