import {
  createGateway,
  createPresetRegistry,
  createProviderRegistry,
  type ModelProviderAdapter,
} from "@covel/ai-provider";
import type { LLMAdapter } from "@covel/shared";
import { createGatewayAdapter } from "../../src/llm/gateway-llm-adapter.js";

/** Exercise actual provider admission while keeping responses deterministic. */
export function throughGateway(llm: LLMAdapter): LLMAdapter {
  const adapter: ModelProviderAdapter = {
    async generateText(config) {
      const result = await llm.generate({
        messages: [],
        signal: config.signal,
        requestBudget: config.requestBudget,
      });
      return {
        ...result,
        text: result.content ?? "",
        toolCalls: [...result.toolCalls],
      };
    },
    async *streamText(config) {
      for await (const event of llm.stream!({
        messages: [],
        signal: config.signal,
        requestBudget: config.requestBudget,
      })) {
        yield event.type === "done"
          ? {
              ...event,
              usage: event.usage ?? { inputTokens: 0, outputTokens: 0 },
            }
          : event;
      }
    },
    async generateObject() {
      throw new Error("not used");
    },
    async embed() {
      throw new Error("not used");
    },
  };
  const result = createGatewayAdapter(
    createGateway({
      presetRegistry: createPresetRegistry({
        profiles: [],
        presets: [
          {
            id: "fixture",
            name: "Fixture",
            model: "fixture",
            provider: "fixture",
            tier: "medium",
            enabled: true,
            isDefault: true,
            supportedModes: ["text", "stream"],
          },
        ],
      }),
      providerRegistry: createProviderRegistry({
        providers: {
          fixture: {
            adapter,
            defaults: { baseUrl: "https://fixture.example" },
          },
        },
      }),
    }),
  );
  if (!llm.stream) delete result.stream;
  return result;
}
