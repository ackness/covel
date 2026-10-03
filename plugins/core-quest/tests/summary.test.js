import { describe, expect, it } from "vitest";
import { loadPluginMessages } from "@covel/plugin-test-utils";
import register from "../server/index.js";

let project;
register({
  provideExtension: (_point, _id, { handler }) => {
    project = handler;
  },
});
// What the host gives the provider as `ctx.messages`: this plugin's translations.
const messages = await loadPluginMessages(
  new URL("..", import.meta.url),
  "zh-CN",
);
const withQuests = (quests) => ({
  messages,
  pluginData: { list: async () => quests.map((value) => ({ value })) },
});

describe("quest session summary", () => {
  it("shows the next open objective of the quest that moved last", async () => {
    const summary = await project(
      { previous: null },
      withQuests([
        {
          name: "Old errand",
          status: "active",
          updatedAt: "2026-01-01",
          objectives: [{ text: "Deliver the letter" }],
        },
        {
          name: "The missing guildmaster",
          updatedAt: "2026-01-05",
          objectives: [
            { text: "Find the ledger", done: true },
            { text: "Ask Tiegu about page 74" },
            { text: "Reach the hospital" },
          ],
        },
        { name: "Closed", status: "completed", updatedAt: "2026-01-09" },
      ]),
    );
    expect(summary).toEqual({
      entries: [
        {
          id: "quest.current",
          kind: "text",
          // Every language the plugin has: the client picks the UI language.
          label: { en: "Objective", zh: "当前目标" },
          value: "Ask Tiegu about page 74",
        },
        {
          id: "quest.progress",
          kind: "meter",
          label: "The missing guildmaster",
          value: 1,
          max: 3,
        },
      ],
    });
  });

  it("falls back to the quest name when it has no open objective", async () => {
    const summary = await project(
      { previous: null },
      withQuests([{ name: "Survive the night", objectives: [] }]),
    );
    expect(summary.entries).toEqual([
      expect.objectContaining({ kind: "text", value: "Survive the night" }),
    ]);
  });

  it("adds nothing when no quest is active", async () => {
    const previous = { entries: [] };
    expect(
      await project(
        { previous },
        withQuests([{ name: "Closed", status: "failed" }]),
      ),
    ).toEqual({ entries: [] });
  });
});
