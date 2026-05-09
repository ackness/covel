import { describe, expect, it } from "vitest";
import {
  buildPluginPanelInitialState,
  expandIndexedState,
  flattenStateForPluginPanel,
} from "../plugin-panel-state.js";

describe("plugin-panel state helpers", () => {
  it("builds json-render initial state with entries and invoking status", () => {
    const state = buildPluginPanelInitialState(
      {
        characters: [
          {
            id: "mentor",
            name: "Lin Yue",
            tags: ["teacher", "sword"],
            stats: { realm: "Foundation" },
          },
        ],
      },
      { "runtime:image": true },
    );

    expect(state.entries).toEqual([
      {
        key: "characters",
        value: [
          {
            id: "mentor",
            name: "Lin Yue",
            tags: ["teacher", "sword"],
            stats: { realm: "Foundation" },
          },
        ],
      },
    ]);
    expect(state._invoking).toEqual({ "runtime:image": true });
    expect(state.character1Id).toBe("mentor");
    expect(state.character1Name).toBe("Lin Yue");
    expect(state.character1Tags1).toBe("teacher");
    expect(state.character1StatsRealm).toBe("Foundation");
  });

  it("expands indexed array state with plural key singularization", () => {
    expect(
      expandIndexedState({
        stories: ["first", "second"],
        items: [[1, 2]],
      }),
    ).toMatchObject({
      story1: "first",
      story2: "second",
      item11: 1,
      item12: 2,
    });
  });

  it("flattens nested objects while keeping arrays at their parent path", () => {
    expect(
      flattenStateForPluginPanel({
        entries: [{ key: "a", value: 1 }],
        nested: { value: 2 },
        empty: null,
      }),
    ).toEqual({
      "/entries": [{ key: "a", value: 1 }],
      "/nested/value": 2,
      "/empty": null,
    });
  });
});
