import { describe, expect, it, vi } from "vitest";
import { loadPluginMessages } from "@covel/plugin-test-utils";
import { sessionSummarySchema } from "@covel/shared";
import register from "../server/index.js";
import { DEFAULT_TIME, describeTime, initialTick } from "../clock.js";

let project;
register({
  registerRpc: vi.fn(),
  registerTool: vi.fn(),
  toolkit: { tool: (definition) => definition, store: {} },
  provideExtension: (_point, _id, { handler }) => {
    project = handler;
  },
});
// What the host gives the provider as `ctx.messages`: this plugin's translations.
const messages = await loadPluginMessages(
  new URL("..", import.meta.url),
  "zh-CN",
);
const withClock = (value, locale = "en") => ({
  locale,
  messages,
  pluginData: { get: async () => value ?? null },
});

describe("world-time session summary", () => {
  it("shows the committed clock in the session language", async () => {
    const tick = initialTick(DEFAULT_TIME);
    const previous = {
      entries: [{ id: "other", kind: "text", label: "Other", value: "kept" }],
    };
    const summary = await project(
      { previous },
      withClock({ schemaVersion: 1, definition: DEFAULT_TIME, tick }, "zh"),
    );
    expect(sessionSummarySchema.parse(summary)).toEqual({
      entries: [
        previous.entries[0],
        {
          id: "time.now",
          kind: "text",
          // Every language the plugin has: the client picks the UI language.
          label: { en: "Time", zh: "时间" },
          value: describeTime(DEFAULT_TIME, tick, "zh").display,
        },
      ],
    });
  });

  it("adds nothing before the clock is recorded or when it is unreadable", async () => {
    expect(await project({ previous: null }, withClock(null))).toEqual({
      entries: [],
    });
    expect(
      await project(
        { previous: null },
        withClock({
          schemaVersion: 1,
          definition: { kind: "unknown" },
          tick: 0,
        }),
      ),
    ).toEqual({ entries: [] });
  });
});
