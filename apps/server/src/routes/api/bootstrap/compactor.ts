import type { LLMAdapter } from "@covel/runtime";
import type { DataStore } from "@covel/store";
import {
  estimateTokens,
  maybeCompact,
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
 * Live view of the main narrative slot's model budget. Implemented in the
 * composition root (app.ts) against the AI registries so llm.toml hot-reloads
 * are observed without a server restart — resolve on every call, never cache.
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

/** Resolution order: env override > slot model capability > fallback. */
function resolveContextWindow(params: BudgetSourceParams): number {
  return (
    params.contextWindowOverride ??
    params.resolveNarrativeBudget?.()?.contextWindow ??
    FALLBACK_CONTEXT_WINDOW
  );
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

  const fastSlotLlm: CompactorLLMAdapter = {
    async complete(input) {
      const response = await llmAdapter.generate({
        model: "fast",
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

  return {
    async run(sessionId, systemPromptPreview, messages, locale, traceId) {
      // The compactor only ships zh-CN / en-US prompt templates; map the
      // session locale by prefix (en* → en-US, else the zh-CN default).
      const compactorLocale =
        typeof locale === "string" && locale.toLowerCase().startsWith("en")
          ? "en-US"
          : "zh-CN";
      return await maybeCompact(
        sessionId,
        systemPromptPreview,
        messages,
        {
          store,
          estimator: estimateTokens,
          fastSlotLlm,
          // Resolved per run so llm.toml hot-reloads take effect immediately.
          contextWindow: resolveContextWindow(params),
        },
        {
          focusSections,
          locale: compactorLocale,
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
      return resolveContextWindow(params);
    },
    get reservedForResponse(): number {
      return (
        params.resolveNarrativeBudget?.()?.maxOutputTokens ??
        DEFAULT_RESERVED_FOR_RESPONSE
      );
    },
  };
}
