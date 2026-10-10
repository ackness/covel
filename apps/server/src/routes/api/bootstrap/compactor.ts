import {
  resolveRequestContextBudget,
  type PluginExtensionHost,
  type LLMAdapter,
} from "@covel/runtime";
import {
  historyCompactV2,
  resolveI18nText,
  resolveLlmTokenLimits,
  type I18nText,
} from "@covel/shared";
import type { DataStore } from "@covel/store";
import {
  estimateTokens,
  maybeCompact,
  type BudgetOptions,
  type CompactorResult,
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

/** Failed attempts in a row before the player is told; repeated every time it recurs. */
export const COMPACTION_NOTICE_EVERY = 3;

const COMPACTION_NOTICE: I18nText = {
  "en-US":
    "The story's memory could not be condensed for several turns, so the prompt keeps growing and may eventually fill the model's context. Check that the model for the fast slot works in Settings, or turn History Compaction off for this session.",
  "zh-CN":
    "故事的记忆已连续多个回合无法压缩，提示词会越来越长，最终可能占满模型的上下文。请在设置里检查“快速”槽位的模型是否可用，或在本会话中关闭历史压缩插件。",
};

export function createBootstrapCompactorRunner(
  params: CreateBootstrapCompactorRunnerParams,
): CompactorRunner {
  const { extensions, store, llmAdapter } = params;
  // Consecutive failed attempts per session. A restart forgets them, which only
  // delays the next notice.
  const failures = new Map<string, number>();

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
      const storyBudget = resolveRequestContextBudget(
        createTurnContextBudget(params),
        llmAdapter,
        "story",
      );
      let failure:
        | {
            readonly pluginId: string;
            readonly providerId: string;
            readonly reason: string;
          }
        | undefined;
      const execution = extensions.createExecution({
        sessionId,
        onProviderError: ({ pluginId, providerId, error }) => {
          failure = {
            pluginId,
            providerId,
            reason: error instanceof Error ? error.message : String(error),
          };
        },
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
      const reportFailure = async (
        found: NonNullable<typeof failure>,
      ): Promise<void> => {
        const count = (failures.get(sessionId) ?? 0) + 1;
        failures.set(sessionId, count);
        console.warn(
          `[compactor] history compaction failed for session ${sessionId} (${count} in a row): ${found.reason}`,
        );
        if (!trace) return;
        await trace.emit("context.compaction.failed", {
          pluginId: found.pluginId,
          extensionId: found.providerId,
          reason: found.reason,
          consecutiveFailures: count,
        });
        if (count % COMPACTION_NOTICE_EVERY !== 0) return;
        // The execution timeline already shows a failed background job with its
        // message, so the notice rides the job-status channel.
        await trace.emit("job-status.updated", {
          sessionId,
          progressScopeId: trace.turnId,
          pluginId: found.pluginId,
          runtimeId: found.providerId
            ? `${found.pluginId}/${found.providerId}`
            : found.pluginId,
          jobId: `history-compaction:${trace.turnId}`,
          state: "failed",
          message: resolveI18nText(COMPACTION_NOTICE, locale ?? "zh-CN"),
          sequence: 1,
          createdAt: new Date().toISOString(),
        });
      };
      let result: CompactorResult;
      try {
        result = await maybeCompact(
          sessionId,
          systemPromptPreview,
          messages,
          {
            store,
            estimator: estimateTokens,
            compact: (input) => execution.run(historyCompactV2, input),
            inputWindow:
              budget.maxInputTokens - (budget.reservedForResponse ?? 0),
            contextWindow: Math.min(
              budget.maxInputTokens - (budget.reservedForResponse ?? 0),
              storyBudget.maxInputTokens -
                (storyBudget.reservedForResponse ?? 0),
            ),
          },
          {
            ...(locale ? { locale } : {}),
            ...(traceId ? { traceId } : {}),
          },
        );
      } catch (error) {
        // Cancellation belongs to the turn. Anything else, such as a provider
        // result the budget rejects, only means the prompt stays uncompacted.
        if (signal?.aborted) throw error;
        await reportFailure({
          pluginId: failure?.pluginId ?? historyCompactV2.id,
          providerId: failure?.providerId ?? "",
          reason: error instanceof Error ? error.message : String(error),
        });
        return { compacted: false };
      }
      if (failure) await reportFailure(failure);
      else failures.delete(sessionId);
      return result;
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
