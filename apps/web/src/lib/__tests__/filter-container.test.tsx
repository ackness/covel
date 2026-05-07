/**
 * FilterContainer + Tabs + SearchInput tests.
 *
 * Two layers:
 * 1. Pure filter helpers (no React) — exercise path resolution + filtering.
 * 2. Component integration — render FilterContainer, type into the search
 *    input, click tabs, and assert the filtered card list updates.
 */

import { describe, it, expect } from "vitest";
import {
  render,
  screen,
  within,
  fireEvent,
  cleanup,
} from "@testing-library/react";
import { afterEach } from "vitest";
import { JSONUIProvider } from "@json-render/react";
import { covelRegistry, __filterContainerInternals } from "../catalog.js";

const { resolvePath, valueToHaystack, filterItems } =
  __filterContainerInternals;

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

const ITEM_PROP_MAP = {
  title: "value/title",
  content: "value/content",
  category: "value/category",
  tags: "value/tags",
  rarity: "value/rarity",
};

function renderFilterContainer(overrides: Record<string, unknown> = {}) {
  const FilterContainer = covelRegistry.FilterContainer;
  return render(
    <JSONUIProvider registry={covelRegistry}>
      <FilterContainer
        element={{
          type: "FilterContainer",
          props: {
            items: FIXTURE_ITEMS,
            searchPlaceholder: { zh: "搜索…", en: "Search…" },
            searchFields: ["value/title", "value/content", "value/tags"],
            filterField: "value/category",
            filterTabs: FILTER_TABS,
            itemComponent: "EntryCard",
            itemPropMap: ITEM_PROP_MAP,
            itemKeyField: "key",
            ...overrides,
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
}

describe("FilterContainer component", () => {
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

  it("renders an error hint when itemComponent is unknown", () => {
    renderFilterContainer({ itemComponent: "DefinitelyNotRegistered" });
    expect(screen.getByText(/not found in registry/)).toBeDefined();
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

  it("forwards itemLiteralProps to every rendered item", () => {
    renderFilterContainer({
      itemLiteralProps: { collapsible: true, defaultExpanded: false },
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
    const Tabs = covelRegistry.Tabs;
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
