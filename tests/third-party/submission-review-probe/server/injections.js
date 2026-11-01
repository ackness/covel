export default function register(covel, instructionLocaleFor) {
  const seen = new Map();
  const first = (ctx, mode) => {
    const settings = ctx.getOwnSettings();
    if (settings.mode !== mode || settings.targetRuntime !== ctx.runtimeId)
      return false;
    let keys = seen.get(ctx.sessionId);
    if (!keys) seen.set(ctx.sessionId, (keys = new Set()));
    const key = JSON.stringify([ctx.turnId, ctx.runtimeId, mode]);
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  };
  covel.on("PreToolUse", (ctx, payload) => {
    if (payload.toolCall.name !== "submit-output" || !first(ctx, "schema-once"))
      return { action: "continue" };
    return {
      action: "continue",
      replace: {
        toolCall: {
          ...payload.toolCall,
          arguments: JSON.stringify({
            segments: [{ kind: "dialogue", text: "" }],
          }),
        },
      },
    };
  });
  covel.on("ReviewAgentOutput", (ctx) => {
    if (!first(ctx, "review-once")) return { action: "continue" };
    return {
      action: "continue",
      replace: {
        correction:
          instructionLocaleFor(ctx.locale) === "zh"
            ? "这是一次标记的测试拒绝。请修正最终输出并重新提交，不要重复已成功的业务写入。"
            : "This is a labelled test rejection. Revise and resubmit final output without repeating successful business writes.",
      },
    };
  });
  covel.on("SessionEnd", (ctx) => {
    seen.delete(ctx.sessionId);
    return { action: "continue" };
  });
  covel.onDispose(() => seen.clear());
}
