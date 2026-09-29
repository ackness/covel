import { describe, expect, it } from "vitest";
import { createStateStore } from "@json-render/react";
import {
  buildPluginPanelInitialState,
  expandIndexedState,
  flattenStateForPluginPanel,
  parsePluginUiState,
  resolvePluginPanelSources,
  syncPluginPanelState,
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
      "/nested": {},
      "/nested/value": 2,
      "/empty": null,
    });
  });

  it("clears finished invocations and removed external fields", () => {
    const store = createStateStore({});
    syncPluginPanelState(
      store,
      buildPluginPanelInitialState(
        { removed: { name: "old" }, retained: { removed: true, count: 1 } },
        { "runtime:image": true },
      ),
    );
    expect(store.get("/_invoking/runtime:image")).toBe(true);

    syncPluginPanelState(
      store,
      buildPluginPanelInitialState({ retained: { count: 2 } }, {}),
    );
    expect(store.get("/_invoking")).toEqual({});
    expect(store.get("/removed")).toBeUndefined();
    expect(store.get("/retained/removed")).toBeUndefined();
    expect(store.get("/retained/count")).toBe(2);
  });

  it("replaces shorter arrays and clears their obsolete derived indexes", () => {
    const store = createStateStore({});
    syncPluginPanelState(
      store,
      buildPluginPanelInitialState(
        { characters: [{ name: "First" }, { name: "Second" }] },
        {},
      ),
    );
    syncPluginPanelState(
      store,
      buildPluginPanelInitialState({ characters: [{ name: "Updated" }] }, {}),
    );
    expect(store.get("/characters")).toEqual([{ name: "Updated" }]);
    expect(store.get("/character1Name")).toBe("Updated");
    expect(store.get("/character2Name")).toBeUndefined();
  });

  it("preserves empty objects and JSON Pointer characters in field names", () => {
    const store = createStateStore({});
    syncPluginPanelState(store, { "a/b": { "~name": 1 }, empty: {} });
    expect(store.get("/a~1b/~0name")).toBe(1);
    expect(store.get("/a")).toBeUndefined();
    expect(store.get("/empty")).toEqual({});

    syncPluginPanelState(store, { "a/b": {}, empty: { value: 2 } });
    expect(store.get("/a~1b")).toEqual({});
    expect(store.get("/empty/value")).toBe(2);
    syncPluginPanelState(store, { empty: {} });
    expect(store.get("/a~1b")).toBeUndefined();
    expect(store.get("/empty")).toEqual({});
  });

  it("preserves local drafts when reusing a cached store until the external value changes", () => {
    const store = createStateStore({});
    syncPluginPanelState(store, {
      form: { name: "initial", count: 1 },
      removed: true,
    });
    store.set("/form/name", "edited");
    store.set("/form/localOnly", "nested draft");
    store.set("/draft", "local draft");

    // A remounted panel supplies a fresh snapshot with the same cached store.
    const cachedStore = new Map([["panel", store]]).get("panel")!;
    syncPluginPanelState(cachedStore, { form: { name: "initial", count: 2 } });
    expect(store.get("/form/name")).toBe("edited");
    expect(store.get("/form/count")).toBe(2);
    expect(store.get("/form/localOnly")).toBe("nested draft");
    expect(store.get("/draft")).toBe("local draft");
    expect(store.get("/removed")).toBeUndefined();

    syncPluginPanelState(store, { form: { name: "server update", count: 2 } });
    expect(store.get("/form/name")).toBe("server update");
  });

  it("handles object, array, and scalar replacements without stale descendants", () => {
    const store = createStateStore({});
    for (const value of [
      { nested: { old: true } },
      [1, 2],
      { next: true },
      3,
      { final: true },
      {},
    ]) {
      syncPluginPanelState(store, { value });
      expect(store.get("/value")).toEqual(value);
    }
  });

  it("keeps numeric-keyed objects as objects on creation and type changes", () => {
    const store = createStateStore({});
    const record = { "3": "three", name: "record", nested: { "0": "zero" } };
    syncPluginPanelState(store, { record });
    expect(store.get("/record")).toEqual(record);
    expect(Array.isArray(store.get("/record"))).toBe(false);
    expect(Array.isArray(store.get("/record/nested"))).toBe(false);
    for (const previous of [null, 3, ["old"]]) {
      syncPluginPanelState(store, { record: previous });
      syncPluginPanelState(store, { record });
      expect(store.get("/record")).toEqual(record);
      expect(Array.isArray(store.get("/record"))).toBe(false);
    }
  });

  it("keeps array and derived-entry drafts until external contents change", () => {
    const store = createStateStore({});
    const data = {
      person: { name: "initial" },
      choices: [{ label: "first" }, { label: "second" }],
    };
    syncPluginPanelState(store, buildPluginPanelInitialState(data, {}));
    store.set("/entries/0/value/name", "entry draft");
    store.set("/choices/0/label", "array draft");

    // Invocation start/end and cached-panel remounts rebuild entries. A fresh
    // server response can reconstruct the original data without changing it.
    const invocations: Record<string, true>[] = [{ "runtime:test": true }, {}];
    for (const invoking of invocations) {
      syncPluginPanelState(
        store,
        buildPluginPanelInitialState(structuredClone(data), invoking),
      );
      expect(store.get("/entries/0/value/name")).toBe("entry draft");
      expect(store.get("/choices/0/label")).toBe("array draft");
      expect(store.get("/_invoking")).toEqual(invoking);
    }

    const changed = { person: { name: "server" }, choices: [{ label: "new" }] };
    syncPluginPanelState(store, buildPluginPanelInitialState(changed, {}));
    expect(store.get("/entries/0/value/name")).toBe("server");
    expect(store.get("/choices")).toEqual(changed.choices);
    expect(store.get("/choice2Label")).toBeUndefined();
  });

  it("bounds comparisons of deeply nested external arrays", () => {
    const store = createStateStore({});
    let first: unknown = "leaf";
    let second: unknown = "leaf";
    for (let depth = 0; depth < 5000; depth++) {
      first = { nested: first };
      second = { nested: second };
    }
    syncPluginPanelState(store, { values: [first] });
    const replacement = [second];
    syncPluginPanelState(store, { values: replacement });
    expect(store.get("/values")).toBe(replacement);
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
