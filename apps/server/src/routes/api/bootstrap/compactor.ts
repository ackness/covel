import type { LLMAdapter } from "@covel/runtime";
import type { DataStore } from "@covel/store";
import {
  maybeCompact,
  type CompactorLLMAdapter,
  type CompactorRunner,
} from "@covel/context";
import type { ParsedPluginMd } from "@covel/plugin-loader";

export interface CreateBootstrapCompactorRunnerParams {
  readonly manifestCache: ReadonlyMap<string, readonly ParsedPluginMd[]>;
  readonly store: DataStore;
  readonly llmAdapter: LLMAdapter;
  readonly contextWindow: number;
}

export function createBootstrapCompactorRunner({
  manifestCache,
  store,
  llmAdapter,
  contextWindow,
}: CreateBootstrapCompactorRunnerParams): CompactorRunner {
  const allSummaryFocus = new Set<string>();
  for (const [, manifests] of manifestCache) {
    for (const parsed of manifests) {
      for (const section of parsed.manifest.summaryFocus ?? []) {
        allSummaryFocus.add(section);
      }
    }
  }
  const focusSections: readonly string[] = [...allSummaryFocus];
  const simpleEstimator = (text: string): number => Math.ceil(text.length / 4);

  const fastSlotLlm: CompactorLLMAdapter = {
    async complete(params) {
      const response = await llmAdapter.generate({
        model: "fast",
        messages: [
          { role: "system", content: params.systemPrompt },
          ...params.messages.map((m) => ({
            role: m.role as "user",
            content: m.content,
          })),
        ],
      });
      return { content: response.content ?? "" };
    },
  };

  return {
    async run(sessionId, systemPromptPreview, messages) {
      await maybeCompact(
        sessionId,
        systemPromptPreview,
        messages,
        {
          store,
          estimator: simpleEstimator,
          fastSlotLlm,
          contextWindow,
        },
        {
          focusSections,
        },
      );
    },
  };
}
