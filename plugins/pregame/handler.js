/**
 * Pre-Game handler — pure function runtime, no LLM.
 *
 * Reads world info and builds a welcome notification. Reports preGameDone=true
 * so the kernel records completion in session.preGameCompleted. Session
 * status is not touched — turn advancement is the kernel's job.
 *
 * @param {import('@covel/plugin-loader').FunctionHandlerContext} ctx
 * @returns {Promise<Record<string, unknown>>}
 */
export default async function pregameHandler(ctx) {
  const { sessionId, store } = ctx;

  let worldName = "未知世界";
  let worldSummary = "";

  if (store && typeof store === "object") {
    const s = /** @type {any} */ (store);
    try {
      const session = await s.getSession(sessionId);
      if (session?.worldId) {
        const world = await s.getWorld(session.worldId);
        if (world) {
          worldName = world.name ?? worldName;
          worldSummary = world.description ?? world.summary ?? "";
        }
      }
    } catch {
      // Store may lack world data (e.g. MemoryStore without seed)
    }
  }

  const notifications = [
    {
      level: "info",
      title: `🌍 欢迎来到${worldName}`,
      message: worldSummary || "你的冒险即将开始...",
    },
  ];

  return {
    narrativeOutput: worldSummary
      ? `【${worldName}】${worldSummary}`
      : `游戏初始化完成，欢迎来到${worldName}。`,
    notifications,
    initialized: true,
    preGameDone: true,
  };
}
