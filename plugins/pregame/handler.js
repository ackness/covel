import { pickLocaleText as pick } from "@covel/plugin-handlers-utils";

/**
 * Pre-Game handler — pure function runtime, no LLM.
 *
 * Reads world info and builds a welcome notification. Reports preGameDone=true
 * so the kernel records this runtime as done in session.setupRuntimes. Session
 * status is not touched — lifecycle advancement is the kernel's job.
 *
 * @type {import("@covel/plugin-handlers-utils").PluginFunctionHandler}
 */
export default async function pregameHandler(ctx) {
  const { sessionId, store, locale } = ctx;

  let worldName = pick(locale, "未知世界", "Unknown World");
  let worldSummary = "";

  if (store && typeof store === "object") {
    const s = /** @type {any} */ (store);
    try {
      const session = await s.getSession();
      if (session?.worldId) {
        const world = await s.getWorld();
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

  // completion:"done" is the setup completion signal. narrativeOutput stays a business value
  // (drives the turn message); notifications are a domain effect.
  return {
    outcome: "success",
    value: {
      narrativeOutput,
      initialized: true,
    },
    effects: {
      notifications,
    },
    completion: "done",
  };
}
