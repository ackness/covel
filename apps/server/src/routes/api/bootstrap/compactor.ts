import type { LLMAdapter } from "@covel/runtime";
import type { DataStore } from "@covel/store";
import {
  estimateTokens,
  maybeCompact,
  resolveBudgetOptions,
  type BudgetOptions,
  type CompactorLLMAdapter,
  type CompactorRunner,
} from "@covel/context";
import type { ParsedPluginMd } from "@covel/plugin-loader";

/**
 * Last-resort context window when neither an explicit env override nor a
 * model-capability lookup yields a value (e.g. an unknown model with no
 * llm.toml capability block).
 */
const FALLBACK_CONTEXT_WINDOW = 32768;

/** Matches applyBudget's own default; explicit here because getters can't omit. */
const DEFAULT_RESERVED_FOR_RESPONSE = 4000;

/**
 * Live conservative view of enabled text-slot model budgets. Implemented in
 * the composition root (app.ts) against the AI registries so llm.toml
 * hot-reloads are observed without a restart — resolve on every call.
 */
export type ResolveNarrativeBudgetFn = () =>
  | {
      readonly contextWindow?: number;
      readonly maxOutputTokens?: number;
    }
  | undefined;

interface BudgetSourceParams {
  /** Explicit COVEL_COMPACTOR_CONTEXT_WINDOW override — wins over capability. */
  readonly contextWindowOverride?: number;
  readonly resolveNarrativeBudget?: ResolveNarrativeBudgetFn;
}

function resolveTurnBudget(
  params: BudgetSourceParams,
): ReturnType<typeof resolveBudgetOptions> {
  const narrativeBudget = params.resolveNarrativeBudget?.();
  return resolveBudgetOptions({
    maxInputTokens:
      params.contextWindowOverride ??
      narrativeBudget?.contextWindow ??
      FALLBACK_CONTEXT_WINDOW,
    reservedForResponse:
      narrativeBudget?.maxOutputTokens ?? DEFAULT_RESERVED_FOR_RESPONSE,
  });
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
      const budget = resolveTurnBudget(params);
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
          contextWindow: budget.maxInputTokens - budget.reservedForResponse,
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

/**
 * Budget config for the prompt-assembly hard prune (`applyBudget`) — the last
 * line of defense when compaction is skipped, vetoed, or insufficient.
 * Getter-based so each turn observes the current llm.toml capability.
 */
export function createTurnContextBudget(
  params: BudgetSourceParams,
): Omit<BudgetOptions, "estimator"> {
  return {
    get maxInputTokens(): number {
      return resolveTurnBudget(params).maxInputTokens;
    },
    get reservedForResponse(): number {
      return resolveTurnBudget(params).reservedForResponse;
    },
  };
}
