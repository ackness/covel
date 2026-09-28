import { describe, expect, it } from "vitest";
import { createStateStore } from "@json-render/react";
import {
  buildPluginPanelInitialState,
  expandIndexedState,
  flattenStateForPluginPanel,
  parsePluginUiState,
  resolvePluginPanelSources,
} from "../plugin-panel-state.js";

describe("plugin-panel state helpers", () => {
  it("copies JSON drafts and permits clearing the cache", () => {
    const draft = { text: "草稿", selection: [1, true, null] };
    const copy = parsePluginUiState(draft);
    expect(copy).toEqual(draft);
    expect(copy).not.toBe(draft);
    expect(copy?.selection).not.toBe(draft.selection);
    expect(parsePluginUiState(null)).toBeNull();
    expect(parsePluginUiState({ text: "\u0000".repeat(4000) })).toBeTruthy();
  });

  it("bounds encoded UTF-8 bytes and rejects invalid drafts", () => {
    expect(() => parsePluginUiState({ text: "中".repeat(11000) })).toThrow(
      "32 KiB",
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const value of [
      undefined,
      [],
      "text",
      { value: undefined },
      { value: NaN },
      { value: new Map() },
      cyclic,
    ]) {
      expect(() => parsePluginUiState(value)).toThrow();
    }
  });

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

  it("binds only owner namespaces and replaces stale sources on session changes", () => {
    const bindings = { vertices: "characters", connections: "relations" };
    const store = createStateStore({});
    const first = resolvePluginPanelSources(
      {
        characters: { a: { label: "First" } },
        relations: { ab: {} },
      },
      bindings,
    );
    store.update(
      flattenStateForPluginPanel(buildPluginPanelInitialState({}, {}, first)),
    );
    expect(store.get("/sources/vertices/a/label")).toBe("First");
    expect(store.get("/sources/connections/ab")).toEqual({});

    const second = resolvePluginPanelSources(
      { characters: { b: { label: "Second" } } },
      bindings,
    );
    store.update(
      flattenStateForPluginPanel(buildPluginPanelInitialState({}, {}, second)),
    );
    expect(store.get("/sources/vertices/a")).toBeUndefined();
    expect(store.get("/sources/vertices/b/label")).toBe("Second");
    expect(store.get("/sources/connections")).toEqual({});
  });

  it("ignores inherited namespace names but accepts explicit own names", () => {
    const bindings = { first: "constructor", second: "toString" };
    expect(resolvePluginPanelSources({}, bindings)).toEqual({
      first: {},
      second: {},
    });

    const ownerNamespaces = Object.fromEntries([
      ["constructor", { a: { label: "First" } }],
      ["toString", { b: { label: "Second" } }],
    ]);
    expect(resolvePluginPanelSources(ownerNamespaces, bindings)).toEqual({
      first: { a: { label: "First" } },
      second: { b: { label: "Second" } },
    });
  });
});
