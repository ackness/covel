import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ComponentRenderer } from "@json-render/react";
import { useStateStore } from "@json-render/react";
import { clsx } from "clsx";
import * as Icons from "lucide-react";
import {
  filterItems,
  resolveIcon,
  resolvePath,
  useI18nResolver,
  type FilterTab,
} from "./helpers.js";

// ── Color accents shared by Tabs ────────────────────────────────────────────

const tabColorAccents: Record<string, string> = {
  red: "border-red-500 text-red-600 dark:text-red-400",
  amber: "border-amber-500 text-amber-600 dark:text-amber-400",
  blue: "border-blue-500 text-blue-600 dark:text-blue-400",
  green: "border-green-500 text-green-600 dark:text-green-400",
  purple: "border-purple-500 text-purple-600 dark:text-purple-400",
  cyan: "border-cyan-500 text-cyan-600 dark:text-cyan-400",
};

/**
 * Tabs — visual tab strip with optional icon + color accent.
 * Standalone usage binds the active value via `$bindState`; FilterContainer
 * uses it as a controlled child driven by local React state.
 *
 * Optional `counts: Record<string, number>` suffixes each tab label with
 * `(N)` where N is `counts[tab.value] ?? 0`. Zero values still render,
 * which gives an honest "empty tab" signal instead of hiding it.
 */
export const Tabs: ComponentRenderer = ({ element, bindings }) => {
  const resolve = useI18nResolver();
  const tabs = (element.props?.tabs as FilterTab[]) ?? [];
  const value = (element.props?.value as string) ?? tabs[0]?.value ?? "";
  const counts = element.props?.counts as Record<string, number> | undefined;
  const { set } = useStateStore();
  const bindPath = bindings?.value;
  const onChange = element.props?.__onChange as
    ((next: string) => void) | undefined;

  return (
    <div
      role="tablist"
      className="flex flex-wrap gap-2 border-b border-border pb-1"
    >
      {tabs.map((tab) => {
        const active = value === tab.value;
        const TabIcon = resolveIcon(tab.icon);
        const accent = active && tab.color ? tabColorAccents[tab.color] : "";
        const count = counts ? (counts[tab.value] ?? 0) : undefined;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => {
              if (onChange) onChange(tab.value);
              else if (bindPath) set(bindPath, tab.value);
            }}
            className={clsx(
              "inline-flex items-center gap-1 px-2 py-1 text-[11px] border-b-2 -mb-[5px] transition-colors",
              "ui-eyebrow px-2.5 py-1 border-b-[1.5px]",
              active
                ? clsx("text-foreground", accent || "border-foreground")
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {TabIcon && <TabIcon className="w-3 h-3" />}
            {resolve(tab.label)}
            {count !== undefined && (
              <span className="text-[10px] text-muted-foreground/70 ml-0.5 font-mono">
                ({count})
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
};

// ── Filter Primitives (stateful container + supporting widgets) ──
//
// FilterContainer manages internal search + tab state and renders a
// preconfigured per-item component for each filtered entry. This avoids
// json-render's "children pre-resolved by parent renderer" limitation
// (which would prevent a child template from re-resolving against per-item
// scope) by having the catalog component itself iterate. Tabs is used
// internally by FilterContainer and also exposed standalone for spec authors
// who want a tab strip bound to global state via `$bindState`.
//
// Spec example:
// ```json
// {
//   "component": "FilterContainer",
//   "props": {
//     "items": { "$state": "/entries" },
//     "searchPlaceholder": { "zh": "搜索…", "en": "Search…" },
//     "searchFields": ["value/title", "value/content", "value/tags"],
//     "filterField": "value/category",
//     "filterTabs": [
//       { "value": "all", "label": { "zh": "全部" } },
//       { "value": "monster", "label": { "zh": "怪物" }, "icon": "skull", "color": "red" }
//     ],
//     "itemComponent": "EntryCard",
//     "itemPropMap": {
//       "title": "value/title",
//       "content": "value/content",
//       "category": "value/category",
//       "tags": "value/tags",
//       "rarity": "value/rarity"
//     }
//   }
// }
// ```

/**
 * FilterContainer — stateful catalog primitive that owns search + tab state
 * and renders a per-item child component for each filtered entry.
 *
 * Why not a child template? json-render resolves a parent's children before
 * passing them in, so a generic template can't re-resolve `$item` per filtered
 * row without reaching into renderer internals. Pinning to a registered
 * component name + a flat propName→itemPath map keeps the contract declarative
 * and the implementation framework-agnostic.
 */
export function createFilterContainer(
  getRenderer: (name: string) => ComponentRenderer | undefined,
): ComponentRenderer {
  const FilterContainer: ComponentRenderer = ({ element }) => {
    const { t } = useTranslation();
    const resolve = useI18nResolver();
    const items = (element.props?.items as unknown[]) ?? [];
    const searchPlaceholder = resolve(element.props?.searchPlaceholder);
    const searchFields = (element.props?.searchFields as string[]) ?? [];
    const filterField = element.props?.filterField as string | undefined;
    const filterTabs = (element.props?.filterTabs as FilterTab[]) ?? [];
    const itemComponent = element.props?.itemComponent as string | undefined;
    const itemPropMap =
      (element.props?.itemPropMap as Record<string, string>) ?? {};
    // itemLiteralProps — flat literal values forwarded verbatim to every item
    // instance. Useful for "apply this to all items" switches like `collapsible`.
    // Path-based `itemPropMap` wins on collisions.
    const itemLiteralProps =
      (element.props?.itemLiteralProps as Record<string, unknown>) ?? {};
    const itemKeyField = element.props?.itemKeyField as string | undefined;
    const emptyMessage = resolve(element.props?.emptyMessage);
    const showSearch =
      element.props?.showSearch !== false && searchFields.length > 0;
    const showTabs = element.props?.showTabs !== false && filterTabs.length > 0;
    const showCounts = (element.props?.showCounts as boolean) ?? false;
    const footerRaw = element.props?.footer;

    const initialFilter = filterTabs[0]?.value ?? "all";
    const [searchQuery, setSearchQuery] = useState("");
    const [activeFilter, setActiveFilter] = useState(initialFilter);

    const itemsArray = Array.isArray(items) ? items : [];

    const filtered = useMemo(
      () =>
        filterItems(
          itemsArray,
          searchQuery,
          searchFields,
          filterField,
          activeFilter,
        ),
      [itemsArray, searchQuery, searchFields, filterField, activeFilter],
    );

    // Per-tab counts are computed from the raw (unfiltered) items so that the
    // number next to each tab always reflects "how many items belong to this
    // category in total", independent of the current search query.
    const tabCounts = useMemo(() => {
      if (!showCounts) return undefined;
      const counts: Record<string, number> = {};
      for (const tab of filterTabs) counts[tab.value] = 0;
      for (const item of itemsArray) {
        const fieldValue = filterField
          ? resolvePath(item, filterField)
          : undefined;
        const key = String(fieldValue ?? "");
        for (const tab of filterTabs) {
          if (tab.value === "all" || tab.value === key) {
            counts[tab.value] = (counts[tab.value] ?? 0) + 1;
          }
        }
      }
      return counts;
    }, [showCounts, itemsArray, filterField, filterTabs]);

    const ItemComponent = itemComponent
      ? getRenderer(itemComponent)
      : undefined;
    const SearchIcon = Icons.Search;

    const fallbackEmpty =
      filterField || searchQuery ? t("common.noMatch") : t("common.noData");

    return (
      <div className="flex flex-col gap-2">
        {showSearch && (
          <div className="relative">
            <SearchIcon className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder || "search"}
              className="ui-input-shell w-full bg-background border border-border pl-7 pr-3 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring text-foreground placeholder:text-muted-foreground"
            />
          </div>
        )}
        {showTabs && (
          <Tabs
            element={{
              type: "Tabs",
              props: {
                tabs: filterTabs,
                value: activeFilter,
                __onChange: setActiveFilter,
                counts: tabCounts,
              },
            }}
            emit={() => {}}
            on={() => ({
              emit: () => {},
              shouldPreventDefault: false,
              bound: false,
            })}
          />
        )}
        <div className="flex flex-col gap-2">
          {filtered.length === 0 && (
            <p className="ui-empty-copy text-xs italic text-center py-4 mx-auto">
              {emptyMessage || fallbackEmpty}
            </p>
          )}
          {filtered.length > 0 &&
            ItemComponent &&
            filtered.map((item, index) => {
              const itemProps: Record<string, unknown> = {
                ...itemLiteralProps,
              };
              for (const [propName, itemPath] of Object.entries(itemPropMap)) {
                itemProps[propName] = resolvePath(item, itemPath);
              }
              const keyValue = itemKeyField
                ? resolvePath(item, itemKeyField)
                : undefined;
              const reactKey =
                keyValue !== undefined && keyValue !== null
                  ? String(keyValue)
                  : String(index);
              return (
                <ItemComponent
                  key={reactKey}
                  element={{
                    type: itemComponent ?? "EntryCard",
                    props: itemProps,
                  }}
                  emit={() => {}}
                  on={() => ({
                    emit: () => {},
                    shouldPreventDefault: false,
                    bound: false,
                  })}
                />
              );
            })}
          {filtered.length > 0 && !ItemComponent && (
            <p className="text-xs text-red-500 italic">
              FilterContainer: itemComponent &quot;{itemComponent}&quot; not
              found in registry
            </p>
          )}
        </div>
        {footerRaw !== undefined && footerRaw !== null && (
          <FilterContainerFooter
            footer={footerRaw}
            totalCount={itemsArray.length}
          />
        )}
      </div>
    );
  };

  /**
   * FilterContainerFooter — renders either an i18n string footer (with
   * optional `{{count}}` substitution using the total item count) or a
   * structured `{component, props}` spec resolved against the catalog
   * registry. Kept local so the container stays declarative.
   */
  function FilterContainerFooter({
    footer,
    totalCount,
  }: {
    footer: unknown;
    totalCount: number;
  }) {
    const resolve = useI18nResolver();
    if (
      typeof footer === "object" &&
      footer !== null &&
      !Array.isArray(footer)
    ) {
      const obj = footer as Record<string, unknown>;
      const componentName = obj.component as string | undefined;
      if (componentName) {
        const Component = getRenderer(componentName);
        if (!Component) {
          return (
            <p className="text-xs text-red-500 italic">
              FilterContainer footer: component &quot;{componentName}&quot; not
              found
            </p>
          );
        }
        const props = (obj.props as Record<string, unknown>) ?? {};
        return (
          <Component
            element={{ type: componentName, props }}
            emit={() => {}}
            on={() => ({
              emit: () => {},
              shouldPreventDefault: false,
              bound: false,
            })}
          />
        );
      }
    }
    // Treat as i18n string (string or {zh, en} map). Substitute `{{count}}`
    // with the total item count as a convenience for spec authors.
    const raw = resolve(footer);
    const rendered = raw.replace(/\{\{\s*count\s*\}\}/g, String(totalCount));
    if (!rendered) return null;
    return (
      <p className="ui-rule text-[11px] text-muted-foreground text-center pt-1 border-t border-border/60 font-mono tracking-[0.04em]">
        {rendered}
      </p>
    );
  }

  return FilterContainer;
}
