import { translate } from "@covel/plugin-handlers-utils";

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
  const { store } = ctx;

  let worldName = translate(ctx, "Unknown World");
  let worldSummary = "";

  if (store && typeof store === "object") {
    const s = /** @type {any} */ (store);
    try {
      const session = await s.getSession();
      // A new plugin version makes the host run setup again in a session that
      // is already playing. The welcome belongs to the opening only.
      if (session?.phase === "playing") {
        return {
          outcome: "success",
          value: { narrativeOutput: "", initialized: true },
          completion: "done",
        };
      }
    } catch {
      // The phase is unknown; treat the run as the opening.
    }
  }
  const world = ctx.world?.worldRecord;
  if (world) {
    worldName = world.name || worldName;
    worldSummary = world.description ?? "";
  }

  const welcomeTitle = translate(ctx, "🌍 Welcome to {world}", {
    world: worldName,
  });
  const notifications = [
    {
      level: "info",
      title: welcomeTitle,
      message:
        worldSummary || translate(ctx, "Your adventure is about to begin…"),
    },
  ];

  const narrativeOutput = worldSummary
    ? translate(ctx, "[{world}] {summary}", {
        world: worldName,
        summary: worldSummary,
      })
    : translate(ctx, "Game initialized. Welcome to {world}.", {
        world: worldName,
      });

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
