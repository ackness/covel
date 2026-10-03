import { describe, expect, it } from "vitest";
import { loadPluginMessages } from "@covel/plugin-test-utils";
import register from "../server/index.js";

let project;
register({
  registerRpc: () => {},
  provideExtension: (_point, _id, { handler }) => {
    project = handler;
  },
});
// What the host gives the provider as `ctx.messages`: this plugin's translations.
const messages = await loadPluginMessages(
  new URL("..", import.meta.url),
  "zh-CN",
);
const withItems = (items) => ({
  messages,
  pluginData: { list: async () => items.map((value) => ({ value })) },
});

describe("inventory session summary", () => {
  it("lists carried items, gear in hand first, and keeps earlier entries", async () => {
    const previous = {
      entries: [{ id: "time.now", kind: "text", label: "Time", value: "Dusk" }],
    };
    const summary = await project(
      { previous },
      withItems([
        { name: "Rope", quantity: 1, updatedAt: "2026-01-02" },
        { name: "Coin", quantity: 12, updatedAt: "2026-01-03" },
        {
          name: "Fog lamp",
          quantity: 1,
          equipped: true,
          updatedAt: "2026-01-01",
        },
        // Dropped to zero: kept as a tombstone, never shown.
        { name: "Torch", quantity: 0, removed: true, updatedAt: "2026-01-04" },
      ]),
    );
    expect(summary).toEqual({
      entries: [
        previous.entries[0],
        {
          id: "inventory.items",
          kind: "list",
          // Every language the plugin has: the client picks the UI language.
          label: { en: "Pack", zh: "行囊" },
          items: ["Fog lamp", "Coin ×12", "Rope"],
          total: 3,
        },
      ],
    });
  });

  it("shows the first few items and the full count for a large bag", async () => {
    const summary = await project(
      { previous: null },
      withItems(
        Array.from({ length: 11 }, (_, index) => ({
          name: `Item ${index}`,
          quantity: 1,
        })),
      ),
    );
    expect(summary.entries[0].items).toHaveLength(8);
    expect(summary.entries[0].total).toBe(11);
  });

  it("adds nothing for an empty bag", async () => {
    expect(await project({ previous: null }, withItems([]))).toEqual({
      entries: [],
    });
  });
});
