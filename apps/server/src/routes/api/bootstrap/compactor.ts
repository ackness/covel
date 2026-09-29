import {
  resolveRequestContextBudget,
  type PluginExtensionHost,
  type LLMAdapter,
} from "@covel/runtime";
import { historyCompactV1, resolveLlmTokenLimits } from "@covel/shared";
import type { DataStore } from "@covel/store";
import {
  estimateTokens,
  maybeCompact,
  type BudgetOptions,
  type CompactorRunner,
} from "@covel/context";

interface BudgetSourceParams {
  /** Explicit deployment ceiling, independent of other configured models. */
  readonly contextWindowOverride?: number;
}

export interface CreateBootstrapCompactorRunnerParams extends BudgetSourceParams {
  readonly extensions: PluginExtensionHost;
  readonly store: DataStore;
  readonly llmAdapter: LLMAdapter;
}

export function createBootstrapCompactorRunner(
  params: CreateBootstrapCompactorRunnerParams,
): CompactorRunner {
  const { extensions, store, llmAdapter } = params;

  return {
    async run(
      sessionId,
      systemPromptPreview,
      messages,
      locale,
      traceId,
      trace,
      signal,
    ) {
      // Resolve once per run so a hot reload cannot make the threshold use one
      // capability while the provider call uses another. Compaction input and
      // output share the same model context, so only the window left after the
      // response reserve is available to the compactor prompt.
      const budget = resolveRequestContextBudget(
        createTurnContextBudget(params),
        llmAdapter,
        "fast",
      );
      const execution = extensions.createExecution({
        sessionId,
        ...(trace
          ? {
              turnId: trace.turnId,
              emitter: {
                sessionId,
                turnId: trace.turnId,
                traceId,
                emit: (type, payload) => trace.emit(type, payload),
              },
            }
          : {}),
        locale: locale ?? "zh-CN",
        signal: signal ?? new AbortController().signal,
        readPluginData: (pluginId, namespace) =>
          store.listPluginData(sessionId, pluginId, namespace),
        gateway: {
          resolveSlot: () => null,
          generateObject: async () => {
            throw new Error(
              "Object generation is not available in history compaction",
            );
          },
          generateText: async (input) => {
            const response = await llmAdapter.generate({
              model: input.presetId ?? "fast",
              maxOutputTokens: budget.reservedForResponse,
              messages: [
                ...(input.system
                  ? [{ role: "system" as const, content: input.system }]
                  : []),
                ...(input.messages ?? []),
                ...(input.prompt
                  ? [{ role: "user" as const, content: input.prompt }]
                  : []),
              ],
              signal: input.signal,
            });
            return {
              text: response.content ?? "",
              finishReason: response.finishReason ?? "stop",
              usage: response.usage ?? { inputTokens: 0, outputTokens: 0 },
            };
          },
        },
      });
      return await maybeCompact(
        sessionId,
        systemPromptPreview,
        messages,
        {
          store,
          estimator: estimateTokens,
          compact: (input) => execution.run(historyCompactV1, input),
          contextWindow:
            budget.maxInputTokens - (budget.reservedForResponse ?? 0),
        },
        {
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
