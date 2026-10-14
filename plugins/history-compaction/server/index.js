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
            // A summary is kept only when it ended normally or filled its
            // output limit; one that stopped for another reason is a failure
            // and the raw history stays.
            if (
              result.finishReason !== "stop" &&
              result.finishReason !== "tool_calls" &&
              result.finishReason !== "length"
            )
              throw new Error(
                `History summary generation stopped before it finished (${result.finishReason})`,
              );
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
