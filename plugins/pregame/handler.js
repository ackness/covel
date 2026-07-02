import { pickLocaleText as pick } from "@covel/plugin-handlers-utils";

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
  const { sessionId, store, locale } = ctx;

  let worldName = pick(locale, "未知世界", "Unknown World");
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

  const welcomeTitle = pick(
    locale,
    `🌍 欢迎来到${worldName}`,
    `🌍 Welcome to ${worldName}`,
  );
  const notifications = [
    {
      level: "info",
      title: welcomeTitle,
      message:
        worldSummary ||
        pick(
          locale,
          "你的冒险即将开始...",
          "Your adventure is about to begin…",
        ),
    },
  ];

  const narrativeOutput = worldSummary
    ? `【${worldName}】${worldSummary}`
    : pick(
        locale,
        `游戏初始化完成，欢迎来到${worldName}。`,
        `Game initialized. Welcome to ${worldName}.`,
      );

  return {
    narrativeOutput,
    notifications,
    initialized: true,
    preGameDone: true,
  };
}
