import makeRecordTool from "../tools/record.js";

export default function (covel) {
  const starts = new Map();
  covel.registerTool(makeRecordTool(covel.toolkit));
  covel.on("TurnStart", async (ctx) => {
    starts.set(ctx.sessionId, (starts.get(ctx.sessionId) ?? 0) + 1);
    return { action: "continue" };
  });
  covel.registerRpc("probe-status", async (_payload, ctx) => ({
    pluginId: covel.pluginId,
    hookStarts: starts.get(ctx.sessionId) ?? 0,
  }));
}
