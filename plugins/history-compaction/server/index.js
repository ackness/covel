import { compactHistory } from "./strategy.js";
export default function register(api) {
  api.provideExtension("history.compact@1", "rolling-summary", {
    async handler(input, ctx) {
      if (!ctx.gateway) return null;
      return compactHistory(input, {
        fastSlotLlm: {
          async complete(request) {
            const result = await ctx.gateway.generateText({
              presetId: "fast",
              system: request.systemPrompt,
              messages: request.messages,
              signal: ctx.signal,
            });
            return { content: result.text };
          },
        },
      });
    },
  });
}
