import { compactHistory } from "./strategy.ts";
export default function register(api) {
  api.provideExtension("history.compact@2", "segmented-summary", {
    async handler(input, ctx) {
      if (!ctx.gateway) return null;
      return compactHistory(input, {
        signal: ctx.signal,
        fastSlotLlm: {
          async complete(request) {
            const result = await ctx.gateway.generateText({
              presetId: "fast",
              system: request.systemPrompt,
              messages: request.messages,
              maxOutputTokens: request.maxOutputTokens,
              signal: ctx.signal,
            });
            return {
              content: result.text,
              truncated: result.finishReason === "length",
            };
          },
        },
      });
    },
  });
}
