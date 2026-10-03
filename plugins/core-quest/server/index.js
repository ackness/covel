/**
 * Unified server entry (PLUGIN.md `entry`) — puts the quest the player is on
 * into the session summary: its next open objective and how far along it is.
 */
import { appendSummaryEntries, labelText } from "@covel/plugin-handlers-utils";

export default function (covel) {
  covel.provideExtension("ui.slot@1", "summary", {
    async handler({ previous }, ctx) {
      // The quest that moved last is the one the story is on.
      const quest = (await ctx.pluginData.list("quests"))
        .map((row) => row.value)
        .filter(
          (value) =>
            value &&
            typeof value.name === "string" &&
            (value.status ?? "active") === "active",
        )
        .sort((a, b) =>
          String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")),
        )[0];
      if (!quest) return appendSummaryEntries(previous, []);
      const objectives = (
        Array.isArray(quest.objectives) ? quest.objectives : []
      ).filter((objective) => typeof objective?.text === "string");
      const next = objectives.find((objective) => objective.done !== true);
      const entries = [
        {
          id: "quest.current",
          kind: "text",
          label: labelText(ctx, "Objective"),
          value: next ? next.text : quest.name,
        },
      ];
      if (objectives.length > 1)
        entries.push({
          id: "quest.progress",
          kind: "meter",
          label: quest.name,
          value: objectives.filter((objective) => objective.done === true)
            .length,
          max: objectives.length,
        });
      return appendSummaryEntries(previous, entries);
    },
  });
}
