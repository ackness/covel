import {
  createGateway,
  createPresetRegistry,
  createProviderRegistry,
  type ModelProviderAdapter,
} from "@covel/ai-provider";
import { assertLlmRequestBudget, type EvaluationResult } from "@covel/shared";
import type { ProviderConfig } from "@covel/ai-provider";

/** A real gateway with deterministic wires; each wire invocation spends an attempt. */
export function modelGateway(
  run: (config: ProviderConfig, mode: string) => Promise<void>,
  fallback = false,
) {
  const usage = { inputTokens: 1, outputTokens: 1 };
  const enter = async (config: ProviderConfig, mode: string) => {
    if (config.requestBudget)
      assertLlmRequestBudget(config.requestBudget, {
        signal: config.signal,
        consumeAttempt: true,
      });
    await run(config, mode);
  };
  const adapter: ModelProviderAdapter = {
    async generateText(config) {
      await enter(config, "text");
      return { text: "ok", finishReason: "stop", usage };
    },
    async generateObject<T>(config: ProviderConfig) {
      await enter(config, "object");
      return { object: { ok: true } as T, finishReason: "stop", usage };
    },
    async evaluate(config, params) {
      await enter(config, "evaluate");
      return {
        answers: {} as EvaluationResult<typeof params.questions>["answers"],
        usage,
        model: "fixture",
      };
    },
    async *streamText(config) {
      await enter(config, "stream");
      yield { type: "text-delta", textDelta: "ok" };
      yield { type: "done", finishReason: "stop", usage };
    },
    async embed() {
      throw new Error("not used");
    },
  };
  return createGateway({
    presetRegistry: createPresetRegistry({
      profiles: [],
      presets: ["fixture", ...(fallback ? ["backup"] : [])].map((id) => ({
        id,
        fallbackPresetIds: fallback && id === "fixture" ? ["backup"] : [],
        name: "Fixture",
        model: "fixture",
        provider: "fixture",
        tier: "medium",
        enabled: true,
        isDefault: id === "fixture",
        capability: {
          input: ["text"],
          output: ["text", "evaluation"],
          contextWindow: 4096,
        },
        supportedModes: ["text", "object", "stream", "evaluate"],
      })),
    }),
    providerRegistry: createProviderRegistry({
      providers: {
        fixture: { adapter, defaults: { baseUrl: "https://fixture.example" } },
      },
    }),
  });
}
