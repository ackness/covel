import makeRecordTool from "../tools/record.js";
import makeCardsTool from "../tools/cards.js";

export default function (covel) {
  const starts = new Map();
  covel.onDispose(() => starts.clear());
  covel.registerTool(makeRecordTool(covel.toolkit));
  covel.registerTool(makeCardsTool(covel.toolkit));
  covel.on("TurnStart", async (ctx) => {
    starts.set(ctx.sessionId, (starts.get(ctx.sessionId) ?? 0) + 1);
    return { action: "continue" };
  });
  covel.on("SessionEnd", async (ctx) => {
    starts.delete(ctx.sessionId);
    return { action: "continue" };
  });
  covel.registerRpc("probe-status", async (_payload, ctx) => {
    const hookStarts = starts.get(ctx.sessionId) ?? 0;
    return {
      ok: true,
      message: `Probe status: ${hookStarts} turn starts`,
      pluginId: covel.pluginId,
      hookStarts,
    };
  });
}
