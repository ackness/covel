/**
 * FilterContainer + Tabs + SearchInput tests.
 *
 * Two layers:
 * 1. Pure filter helpers (no React) — exercise path resolution + filtering.
 * 2. Component integration — render FilterContainer, type into the search
 *    input, click tabs, and assert the filtered card list updates.
 */

import { describe, it, expect, vi } from "vitest";
import {
  render,
  screen,
  within,
  fireEvent,
  cleanup,
} from "@testing-library/react";
import { afterEach } from "vitest";
import { JSONUIProvider, Renderer, useStateStore } from "@json-render/react";
import { covelRegistry, __filterContainerInternals } from "../catalog.js";

import { pluginPanelViewToSpec } from "../plugin-panel-spec.js";
import { covelDirectives } from "../json-render-directives.js";
import worldSchemaPanel from "../../../../../plugins/world-init/runtimes/schema-gen/ui/world-schema.json";
import codexPanel from "../../../../../plugins/codex/ui/codex-panel.json";
import questPanel from "../../../../../plugins/core-quest/ui/quest-log-panel.json";
import rulesPanel from "../../../../../plugins/living-world-rules/ui/living-world-rules-panel.json";

const { resolvePath, valueToHaystack, filterItems } =
  __filterContainerInternals;

vi.mock("@/stores/session-store.js", () => ({
  useSession: () => ({ state: { pendingInteractionDrafts: [] } }),
}));
afterEach(cleanup);

const FIXTURE_ITEMS = [
  {
    key: "e1",
    value: {
      title: "Goblin Scout",
      content: "A scrawny goblin armed with a rusty dagger.",
      category: "monster",
      tags: ["weak", "stealth"],
      rarity: "common",
    },
  },
  {
    key: "e2",
    value: {
      title: "Crystal Sword",
      content: "A blade forged from purified moon crystal.",
      category: "item",
      tags: ["weapon", "shiny"],
      rarity: "rare",
    },
  },
  {
    key: "e3",
    value: {
      title: "Whispering Caves",
      content: "Damp tunnels echoing with goblin chatter.",
      category: "location",
      tags: ["dungeon"],
      rarity: "uncommon",
    },
  },
  {
    key: "e4",
    value: {
      title: "Ember Wraith",
      content: "A burning specter that haunts old battlefields.",
      category: "monster",
      tags: ["fire", "spectral"],
      rarity: "legendary",
    },
  },
];

describe("FilterContainer pure helpers", () => {
  describe("resolvePath", () => {
    it("returns the value for a slash-delimited path", () => {
      expect(resolvePath(FIXTURE_ITEMS[0], "value/title")).toBe("Goblin Scout");
    });

    it("returns the value for a dot-delimited path", () => {
      expect(resolvePath(FIXTURE_ITEMS[0], "value.category")).toBe("monster");
    });

    it("returns undefined for a missing segment", () => {
      expect(resolvePath(FIXTURE_ITEMS[0], "value/nope")).toBeUndefined();
    });

    it("indexes into arrays with numeric segments", () => {
      expect(resolvePath(FIXTURE_ITEMS[0], "value/tags/0")).toBe("weak");
    });

    it("returns the original value for an empty path", () => {
      expect(resolvePath(FIXTURE_ITEMS[0], "")).toBe(FIXTURE_ITEMS[0]);
    });

    it("does not throw on null intermediate values", () => {
      expect(resolvePath({ a: null }, "a/b/c")).toBeUndefined();
    });
  });

  describe("valueToHaystack", () => {
    it("flattens an array of strings", () => {
      expect(valueToHaystack(["weak", "stealth"])).toBe("weak stealth");
    });

    it("flattens nested object values", () => {
      expect(valueToHaystack({ a: "x", b: { c: "y" } })).toBe("x y");
    });

    it("returns empty string for null/undefined", () => {
      expect(valueToHaystack(null)).toBe("");
      expect(valueToHaystack(undefined)).toBe("");
    });
  });

  describe("filterItems", () => {
    const searchFields = ["value/title", "value/content", "value/tags"];
    const filterField = "value/category";

    it("returns all items when no filter or query", () => {
      const result = filterItems(
        FIXTURE_ITEMS,
        "",
        searchFields,
        filterField,
        "all",
      );
      expect(result).toHaveLength(4);
    });

    it("filters by tab value", () => {
      const result = filterItems(
        FIXTURE_ITEMS,
        "",
        searchFields,
        filterField,
        "monster",
      );
      expect(
        result.map((i) => (i as (typeof FIXTURE_ITEMS)[number]).key),
      ).toEqual(["e1", "e4"]);
    });

    it("filters by search query against searchFields", () => {
      const result = filterItems(
        FIXTURE_ITEMS,
        "crystal",
        searchFields,
        filterField,
        "all",
      );
      expect(result).toHaveLength(1);
      expect((result[0] as (typeof FIXTURE_ITEMS)[number]).key).toBe("e2");
    });

    it("matches search against array fields (tags)", () => {
      const result = filterItems(
        FIXTURE_ITEMS,
        "spectral",
        searchFields,
        filterField,
        "all",
      );
      expect(result).toHaveLength(1);
      expect((result[0] as (typeof FIXTURE_ITEMS)[number]).key).toBe("e4");
    });

    it("combines tab + search filters (AND)", () => {
      const result = filterItems(
        FIXTURE_ITEMS,
        "goblin",
        searchFields,
        filterField,
        "monster",
      );
      expect(result).toHaveLength(1);
      expect((result[0] as (typeof FIXTURE_ITEMS)[number]).key).toBe("e1");
    });

    it("returns empty when nothing matches the combined filter", () => {
      const result = filterItems(
        FIXTURE_ITEMS,
        "lava",
        searchFields,
        filterField,
        "all",
      );
      expect(result).toHaveLength(0);
    });

    it("treats an undefined filterField as no tab filter", () => {
      const result = filterItems(
        FIXTURE_ITEMS,
        "",
        searchFields,
        undefined,
        "anything",
      );
      expect(result).toHaveLength(4);
    });

    it("is case-insensitive for search", () => {
      const result = filterItems(
        FIXTURE_ITEMS,
        "GOBLIN",
        searchFields,
        filterField,
        "all",
      );
      expect(result).toHaveLength(2);
    });

    it("trims whitespace from the search query", () => {
      const result = filterItems(
        FIXTURE_ITEMS,
        "   ",
        searchFields,
        filterField,
        "all",
      );
      expect(result).toHaveLength(4);
    });
  });
});

// ── Component integration ────────────────────────────────────────

const FILTER_TABS = [
  { value: "all", label: { zh: "全部", en: "All" } },
  {
    value: "monster",
    label: { zh: "怪物", en: "Monsters" },
    icon: "skull",
    color: "red",
  },
  {
    value: "item",
    label: { zh: "物品", en: "Items" },
    icon: "gem",
    color: "blue",
  },
  {
    value: "location",
    label: { zh: "地点", en: "Locations" },
    icon: "map-pin",
  },
];

const ITEM_TEMPLATE = {
  component: "EntryCard",
  props: {
    title: { $item: "value/title" },
    content: { $item: "value/content" },
    category: { $item: "value/category" },
    tags: { $item: "value/tags" },
    rarity: { $item: "value/rarity" },
  },
};

function renderFilterContainer(overrides: Record<string, unknown> = {}) {
  const spec = pluginPanelViewToSpec({
    component: "FilterContainer",
    props: {
      items: { $state: "/entries" },
      searchPlaceholder: { zh: "搜索…", en: "Search…" },
      searchFields: ["value/title", "value/content", "value/tags"],
      filterField: "value/category",
      filterTabs: FILTER_TABS,
      itemTemplate: ITEM_TEMPLATE,
      itemKeyField: "key",
      ...overrides,
    },
  });
  return render(
    <JSONUIProvider
      registry={covelRegistry}
      initialState={{ entries: FIXTURE_ITEMS }}
      directives={covelDirectives}
    >
      <Renderer spec={spec} registry={covelRegistry} />
    </JSONUIProvider>,
  );
}

describe("FilterContainer component", () => {
  it("treats malformed optional paths as absent", () => {
    renderFilterContainer({ filterField: { invalid: true }, itemKeyField: 42 });
    expect(screen.getByText("Goblin Scout")).toBeDefined();
  });

  it("renders all items by default", () => {
    renderFilterContainer();
    expect(screen.getByText("Goblin Scout")).toBeDefined();
    expect(screen.getByText("Crystal Sword")).toBeDefined();
    expect(screen.getByText("Whispering Caves")).toBeDefined();
    expect(screen.getByText("Ember Wraith")).toBeDefined();
  });

  it("filters items by search query", () => {
    renderFilterContainer();
    const searchInput = screen.getByPlaceholderText(
      "搜索…",
    ) as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: "crystal" } });

    expect(screen.queryByText("Goblin Scout")).toBeNull();
    expect(screen.getByText("Crystal Sword")).toBeDefined();
    expect(screen.queryByText("Whispering Caves")).toBeNull();
    expect(screen.queryByText("Ember Wraith")).toBeNull();
  });

  it("filters items by tab click", () => {
    renderFilterContainer();
    const tablist = screen.getByRole("tablist");
    const monsterTab = within(tablist).getByRole("tab", { name: /怪物/ });
    fireEvent.click(monsterTab);

    expect(screen.getByText("Goblin Scout")).toBeDefined();
    expect(screen.getByText("Ember Wraith")).toBeDefined();
    expect(screen.queryByText("Crystal Sword")).toBeNull();
    expect(screen.queryByText("Whispering Caves")).toBeNull();
  });

  it("combines search query and tab filter", () => {
    renderFilterContainer();
    const tablist = screen.getByRole("tablist");
    const monsterTab = within(tablist).getByRole("tab", { name: /怪物/ });
    fireEvent.click(monsterTab);

    const searchInput = screen.getByPlaceholderText(
      "搜索…",
    ) as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: "goblin" } });

    expect(screen.getByText("Goblin Scout")).toBeDefined();
    expect(screen.queryByText("Ember Wraith")).toBeNull();
  });

  it("shows the empty message when no items match", () => {
    renderFilterContainer({
      emptyMessage: { zh: "什么都没找到", en: "Nothing found" },
    });
    const searchInput = screen.getByPlaceholderText(
      "搜索…",
    ) as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: "zzznever" } });

    expect(screen.getByText("什么都没找到")).toBeDefined();
  });

  it("marks the active tab via aria-selected", () => {
    renderFilterContainer();
    const tablist = screen.getByRole("tablist");
    const allTab = within(tablist).getByRole("tab", { name: /全部/ });
    const monsterTab = within(tablist).getByRole("tab", { name: /怪物/ });
    expect(allTab.getAttribute("aria-selected")).toBe("true");
    expect(monsterTab.getAttribute("aria-selected")).toBe("false");

    fireEvent.click(monsterTab);
    expect(allTab.getAttribute("aria-selected")).toBe("false");
    expect(monsterTab.getAttribute("aria-selected")).toBe("true");
  });

  it("hides the search input when searchFields is empty", () => {
    renderFilterContainer({ searchFields: [] });
    expect(screen.queryByPlaceholderText("搜索…")).toBeNull();
  });

  it("hides the tab strip when filterTabs is empty", () => {
    renderFilterContainer({ filterTabs: [] });
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("renders per-tab count suffixes when showCounts is true", () => {
    renderFilterContainer({ showCounts: true });
    const tablist = screen.getByRole("tablist");
    // 4 total items → All (4); 2 monsters; 1 item; 1 location
    expect(
      within(tablist).getByRole("tab", { name: /全部.*\(4\)/ }),
    ).toBeDefined();
    expect(
      within(tablist).getByRole("tab", { name: /怪物.*\(2\)/ }),
    ).toBeDefined();
    expect(
      within(tablist).getByRole("tab", { name: /物品.*\(1\)/ }),
    ).toBeDefined();
    expect(
      within(tablist).getByRole("tab", { name: /地点.*\(1\)/ }),
    ).toBeDefined();
  });

  it("tab counts reflect raw items, not current search query", () => {
    renderFilterContainer({ showCounts: true });
    const searchInput = screen.getByPlaceholderText(
      "搜索…",
    ) as HTMLInputElement;
    // Narrow to a single match, but counts should still be 4 / 2 / 1 / 1.
    fireEvent.change(searchInput, { target: { value: "crystal" } });
    const tablist = screen.getByRole("tablist");
    expect(
      within(tablist).getByRole("tab", { name: /全部.*\(4\)/ }),
    ).toBeDefined();
    expect(
      within(tablist).getByRole("tab", { name: /怪物.*\(2\)/ }),
    ).toBeDefined();
  });

  it("does not render count suffixes when showCounts is omitted", () => {
    renderFilterContainer();
    const tablist = screen.getByRole("tablist");
    // No "(N)" appended.
    expect(within(tablist).queryByText(/\(\d+\)/)).toBeNull();
  });

  it("renders a string footer below the list", () => {
    renderFilterContainer({ footer: { zh: "共 4 条", en: "total 4" } });
    expect(screen.getByText("共 4 条")).toBeDefined();
  });

  it("substitutes {{count}} in the footer with total item count", () => {
    renderFilterContainer({
      footer: { zh: "共 {{count}} 条记录", en: "{{count}} entries" },
    });
    expect(screen.getByText("共 4 条记录")).toBeDefined();
  });

  it("footer count reflects total items, not filtered subset", () => {
    renderFilterContainer({
      footer: { zh: "{{count}} 条", en: "{{count}} entries" },
    });
    const searchInput = screen.getByPlaceholderText(
      "搜索…",
    ) as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: "crystal" } });
    // Only 1 row renders, but footer still says 4.
    expect(screen.getByText("4 条")).toBeDefined();
  });

  it("applies literal template props to every row", () => {
    renderFilterContainer({
      itemTemplate: {
        ...ITEM_TEMPLATE,
        props: {
          ...ITEM_TEMPLATE.props,
          collapsible: true,
          defaultExpanded: false,
        },
      },
    });
    // When collapsible+!defaultExpanded, content is hidden — so we should NOT
    // see any of the body content text. The titles are still visible.
    expect(
      screen.queryByText("A scrawny goblin armed with a rusty dagger."),
    ).toBeNull();
    expect(screen.getByText("Goblin Scout")).toBeDefined();
  });
});

describe("Tabs standalone", () => {
  it("renders tabs and reflects the active value", () => {
    const Tabs = covelRegistry.Tabs!;
    render(
      <JSONUIProvider registry={covelRegistry}>
        <Tabs
          element={{
            type: "Tabs",
            props: {
              tabs: FILTER_TABS,
              value: "monster",
            },
          }}
          emit={() => {}}
          on={() => ({
            emit: () => {},
            shouldPreventDefault: false,
            bound: false,
          })}
        />
      </JSONUIProvider>,
    );

    const monsterTab = screen.getByRole("tab", { name: /怪物/ });
    expect(monsterTab.getAttribute("aria-selected")).toBe("true");
  });
});

describe("FilterContainer row scopes", () => {
  it("renders row subtrees, translated maps and actions through search and tabs", () => {
    const select = vi.fn();
    const view = {
      component: "FilterContainer",
      props: {
        items: { $state: "/entries" },
        searchFields: ["value/title"],
        searchPlaceholder: "Find",
        filterField: "value/category",
        filterTabs: FILTER_TABS,
        itemKeyField: "key",
        itemTemplate: {
          component: "Row",
          children: [
            { component: "Text", props: { content: { $item: "value/title" } } },
            {
              component: "Badge",
              props: {
                label: {
                  $map: { $item: "value/category" },
                  labels: { monster: { en: "Monster", zh: "怪兽" } },
                  fallback: {
                    $concat: ["Other: ", { $item: "value/category" }],
                  },
                },
              },
            },
            {
              component: "Button",
              props: { label: { $concat: ["Select ", { $index: true }] } },
              on: {
                click: {
                  action: "select",
                  params: {
                    payload: {
                      id: { $item: "key" },
                      title: { $item: "value/title" },
                      index: { $index: true },
                    },
                  },
                },
              },
            },
          ],
        },
      },
    };
    render(
      <JSONUIProvider
        registry={covelRegistry}
        initialState={{ entries: FIXTURE_ITEMS }}
        handlers={{ select }}
        directives={covelDirectives}
      >
        <Renderer spec={pluginPanelViewToSpec(view)} registry={covelRegistry} />
      </JSONUIProvider>,
    );
    expect(screen.getAllByText("怪兽")).toHaveLength(2);
    expect(screen.getByText("Other: item")).toBeDefined();
    fireEvent.click(screen.getByRole("tab", { name: /怪物/ }));
    fireEvent.change(screen.getByPlaceholderText("Find"), {
      target: { value: "ember" },
    });
    expect(screen.queryByText("Goblin Scout")).toBeNull();
    expect(screen.getAllByText("怪兽")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Select 3" }));
    expect(select).toHaveBeenCalledWith({
      payload: { id: "e4", title: "Ember Wraith", index: 3 },
    });
  });

  it("keeps original array paths for nested repeat and editable row bindings after filtering", () => {
    const select = vi.fn();
    const view = {
      component: "Stack",
      repeat: { statePath: "/groups" },
      children: [
        {
          component: "FilterContainer",
          props: {
            items: { $item: "rows" },
            searchFields: ["name"],
            searchPlaceholder: "Find",
            itemTemplate: {
              component: "Stack",
              children: [
                {
                  component: "Input",
                  props: { value: { $bindItem: "name" }, placeholder: "Name" },
                },
                {
                  component: "Stack",
                  repeat: { statePath: { $item: "tags" } },
                  children: [
                    {
                      component: "Button",
                      props: { label: { $item: "text" } },
                      on: {
                        click: {
                          action: "select",
                          params: { payload: { $item: "" } },
                        },
                      },
                    },
                  ],
                },
              ],
            },
          },
        },
      ],
    };
    render(
      <JSONUIProvider
        registry={covelRegistry}
        initialState={{
          groups: [
            {
              rows: [
                { name: "first", tags: [{ text: "one" }] },
                { name: "second", tags: [{ text: "two" }] },
              ],
            },
          ],
        }}
        handlers={{ select }}
      >
        <Renderer spec={pluginPanelViewToSpec(view)} registry={covelRegistry} />
      </JSONUIProvider>,
    );
    fireEvent.change(screen.getByPlaceholderText("Find"), {
      target: { value: "second" },
    });
    expect(screen.queryByRole("button", { name: "one" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "two" }));
    // Direct $item action params follow json-render's state-path semantics.
    expect(select).toHaveBeenCalledWith({ payload: "/groups/0/rows/1/tags/0" });
    fireEvent.change(screen.getByPlaceholderText("Name"), {
      target: { value: "second edited" },
    });
    fireEvent.change(screen.getByPlaceholderText("Find"), {
      target: { value: "" },
    });
    expect(
      screen
        .getAllByPlaceholderText("Name")
        .map((input) => (input as HTMLInputElement).value),
    ).toEqual(["first", "second edited"]);
  });

  it("preserves row component state by key when source rows reorder", () => {
    function Reorder() {
      const { set } = useStateStore();
      return (
        <button onClick={() => set("/entries", [...FIXTURE_ITEMS].reverse())}>
          Reverse
        </button>
      );
    }
    const spec = pluginPanelViewToSpec({
      component: "FilterContainer",
      props: {
        items: { $state: "/entries" },
        itemKeyField: "key",
        itemTemplate: {
          ...ITEM_TEMPLATE,
          props: {
            ...ITEM_TEMPLATE.props,
            collapsible: true,
            defaultExpanded: false,
          },
        },
      },
    });
    render(
      <JSONUIProvider
        registry={covelRegistry}
        initialState={{ entries: FIXTURE_ITEMS }}
      >
        <Reorder />
        <Renderer spec={spec} registry={covelRegistry} />
      </JSONUIProvider>,
    );
    fireEvent.click(screen.getByText("Goblin Scout"));
    expect(screen.getByText(FIXTURE_ITEMS[0]!.value.content)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Reverse" }));
    expect(screen.getByText(FIXTURE_ITEMS[0]!.value.content)).toBeDefined();
    expect(screen.queryByText(FIXTURE_ITEMS[3]!.value.content)).toBeNull();
  });

  it("renders mapped type/category badges from the bundled character-schema panel", () => {
    render(
      <JSONUIProvider
        registry={covelRegistry}
        initialState={{
          attributes: [
            { id: "hp", name: "Health", type: "number", category: "stats" },
          ],
        }}
        directives={covelDirectives}
      >
        <Renderer
          spec={pluginPanelViewToSpec(worldSchemaPanel.view)}
          registry={covelRegistry}
        />
      </JSONUIProvider>,
    );
    expect(screen.getByText("Number")).toBeDefined();
    expect(screen.getByText("Stats")).toBeDefined();
    expect(screen.queryByText("number")).toBeNull();
  });

  it.each([
    [
      "codex",
      codexPanel.view,
      { title: "Known creature", category: "monster", content: "Details" },
      "Known creature",
      "Monsters",
    ],
    [
      "quests",
      questPanel.view,
      { name: "Find the key", status: "active", description: "Details" },
      "Find the key",
      "Active",
    ],
    [
      "rules",
      rulesPanel.view,
      { title: "Quiet nights", kind: "constant", content: "Details" },
      "Quiet nights",
      "Constant",
    ],
  ])("renders migrated %s rows", (_name, view, value, title, badge) => {
    render(
      <JSONUIProvider
        registry={covelRegistry}
        initialState={{ entries: [{ key: "row", value }] }}
        directives={covelDirectives}
      >
        <Renderer spec={pluginPanelViewToSpec(view)} registry={covelRegistry} />
      </JSONUIProvider>,
    );
    expect(screen.getByText(title as string)).toBeDefined();
    expect(screen.getAllByText(badge as string).length).toBeGreaterThan(0);
  });
});
