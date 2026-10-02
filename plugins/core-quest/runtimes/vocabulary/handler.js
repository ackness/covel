const MAX_ENTRIES = 30;
const MAX_DETAILS = 12;

/**
 * Publish the active quests and their open objectives so the shared WorldIR
 * extraction reports progress under the same names.
 *
 * @type {import("@covel/plugin-handlers-utils").PluginFunctionHandler}
 */
export default async function handler(ctx) {
  const rows = (await ctx.store.listPluginData("quests")) ?? [];
  const entries = rows
    .map((row) => row.value)
    .filter(
      (quest) =>
        quest &&
        (quest.status ?? "active") === "active" &&
        typeof quest.name === "string" &&
        quest.name.trim(),
    )
    .slice(0, MAX_ENTRIES)
    .map((quest) => {
      const details = (Array.isArray(quest.objectives) ? quest.objectives : [])
        .filter(
          (objective) =>
            objective?.done !== true &&
            typeof objective?.text === "string" &&
            objective.text.trim(),
        )
        .slice(0, MAX_DETAILS)
        .map((objective) => objective.text.trim());
      return {
        type: "quest",
        name: quest.name.trim(),
        ...(details.length ? { details } : {}),
      };
    });
  return { outcome: "success", value: { entries } };
}
