// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { SessionPlugin } from "@covel/shared";
import { initialState, reducer } from "../session-store/reducer.js";

function sessionPlugin(
  id: string,
  active: boolean,
  locked = false,
): SessionPlugin {
  return {
    requires: [],
    optional: [],
    conflicts: [],
    extensions: [],
    eventTopics: [],
    id,
    displayName: id,
    description: `${id} plugin`,
    kind: locked ? "core" : "plugin",
    source: "builtin",
    hostState: "loaded",
    runtimeCount: 0,
    provides: [],
    tags: [],
    runtimes: [],
    tools: [],
    userSettings: [],
    languages: { text: ["en"], instructions: ["en"] },
    active,
    serverCodeApproved: true,
    sessionState: active ? "active" : "inactive",
    locked,
  };
}

describe("session plugin reducer", () => {
  it("loads the canonical session plugin list", () => {
    const plugins = [
      sessionPlugin("narrator", true, true),
      sessionPlugin("memory", false),
    ];

    const state = reducer(initialState, {
      type: "LOAD_SESSION_PLUGINS",
      plugins,
    });

    expect(state.sessionPlugins).toEqual(plugins);
  });

  it("optimistically changes only the target active flag", () => {
    const loaded = reducer(initialState, {
      type: "LOAD_SESSION_PLUGINS",
      plugins: [
        sessionPlugin("narrator", true),
        sessionPlugin("memory", false),
      ],
    });

    const state = reducer(loaded, {
      type: "TOGGLE_SESSION_PLUGIN",
      pluginId: "memory",
      active: true,
    });

    expect(
      state.sessionPlugins.map(({ id, active }) => ({ id, active })),
    ).toEqual([
      { id: "narrator", active: true },
      { id: "memory", active: true },
    ]);
    expect(loaded.sessionPlugins[1]?.active).toBe(false);
  });

  it("keeps state identity when the plugin is unknown", () => {
    const loaded = reducer(initialState, {
      type: "LOAD_SESSION_PLUGINS",
      plugins: [sessionPlugin("narrator", true)],
    });
    expect(
      reducer(loaded, {
        type: "TOGGLE_SESSION_PLUGIN",
        pluginId: "missing",
        active: false,
      }),
    ).toBe(loaded);
  });
});
