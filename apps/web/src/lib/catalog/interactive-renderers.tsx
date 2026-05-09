import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ComponentRenderer } from "@json-render/react";
import { useStateStore } from "@json-render/react";
import { clsx } from "clsx";
import * as Icons from "lucide-react";
import {
  resolveActionParams,
  matchesPendingDraft,
} from "../interaction-selection.js";
import { useSession } from "@/stores/session-store.js";
import {
  filterItems,
  resolveIcon,
  resolvePath,
  useI18nResolver,
  type FilterTab,
} from "./helpers.js";

// ── Interactive Components ───────────────────────────────────────

export const Button: ComponentRenderer = ({ element, emit }) => {
  const resolve = useI18nResolver();
  const label = resolve(element.props?.label);
  const variant = (element.props?.variant as string) ?? "default";
  const size = (element.props?.size as string) ?? "md";

  // ── Selection feedback for plugin-declared interactions ────────────
  //
  // When the user clicks a plugin-supplied button whose action stashes a
  // pending draft (draftMessage / selectChoice / etc.), we echo the choice
  // back visually so the player can see what they picked. The match is
  // framework-neutral: we only inspect the click binding's params and the
  // active drafts; no plugin IDs anywhere.
  const { state } = useSession();
  const pendingDrafts = state.pendingInteractionDrafts;
  const { get: getState } = useStateStore();
  const isSelected = useMemo(() => {
    if (pendingDrafts.length === 0) return false;
    const click = element.on?.click;
    if (!click) return false;
    const bindings = Array.isArray(click) ? click : [click];
    for (const binding of bindings) {
      const resolved = resolveActionParams(
        binding.params as Record<string, unknown> | undefined,
        getState,
      );
      if (matchesPendingDraft(resolved, pendingDrafts)) return true;
    }
    return false;
  }, [element.on, pendingDrafts, getState]);

  // ── In-flight feedback for plugin-rpc dispatch ─────────────────────
  //
  // PluginPanel writes `/_invoking/<key>` whenever an `invokeRuntime` /
  // `invokePluginAction` click is mid-flight. The button's click binding
  // tells us which key it would set, so we can show a spinner exactly on
  // the button that fired the action — no risk of dimming the whole panel.
  const invokingMap =
    (getState("/_invoking") as Record<string, boolean> | undefined) ?? {};
  const isPending = useMemo(() => {
    const click = element.on?.click;
    if (!click) return false;
    const bindings = Array.isArray(click) ? click : [click];
    for (const binding of bindings) {
      const resolved = resolveActionParams(
        binding.params as Record<string, unknown> | undefined,
        getState,
      );
      if (
        binding.action === "invokeRuntime" &&
        typeof resolved.runtimeId === "string"
      ) {
        if (invokingMap[`runtime:${resolved.runtimeId}`]) return true;
      }
      if (
        binding.action === "invokePluginAction" &&
        typeof resolved.action === "string"
      ) {
        if (invokingMap[`action:${resolved.action}`]) return true;
      }
    }
    return false;
  }, [element.on, invokingMap, getState]);

  const Loader = Icons.Loader2;

  return (
    <button
      type="button"
      onClick={() => emit("click")}
      disabled={isPending || undefined}
      aria-pressed={isSelected || undefined}
      aria-busy={isPending || undefined}
      data-selected={isSelected ? "true" : undefined}
      data-pending={isPending ? "true" : undefined}
      className={clsx(
        "font-medium rounded-[var(--radius-control)] transition-all text-left relative inline-flex items-center gap-1.5",
        size === "compact"
          ? "px-2.5 py-1 text-[11px]"
          : "px-3.5 py-1.5 text-xs",
        !isSelected &&
          variant === "primary" &&
          "bg-foreground text-[var(--surface-page)] hover:bg-foreground/90",
        !isSelected &&
          variant === "default" &&
          "bg-transparent text-foreground border border-border hover:border-foreground/40 hover:bg-foreground/5",
        !isSelected &&
          variant === "ghost" &&
          "bg-transparent text-muted-foreground border border-dashed border-border hover:border-foreground/40 hover:text-foreground",
        !isSelected &&
          variant === "danger" &&
          "bg-[var(--accent-danger)] text-white hover:opacity-90",
        isSelected &&
          "bg-[color-mix(in_oklab,var(--accent-primary)_8%,transparent)] text-[var(--accent-primary)] border border-[var(--accent-primary)]",
        isPending && "opacity-70 cursor-progress",
      )}
    >
      {isPending && (
        <Loader aria-hidden="true" className="w-3 h-3 animate-spin" />
      )}
      {!isPending && isSelected && (
        <span aria-hidden="true" className="inline-block text-primary">
          ✓
        </span>
      )}
      <span>{label}</span>
    </button>
  );
};

const inputBase =
  "ui-input-shell w-full bg-background border border-border px-2.5 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring text-foreground placeholder:text-muted-foreground";

export const Input: ComponentRenderer = ({ element, bindings }) => {
  const resolve = useI18nResolver();
  const placeholder = resolve(element.props?.placeholder);
  const label = resolve(element.props?.label);
  const value = (element.props?.value as string) ?? "";
  const { set } = useStateStore();
  const bindPath = bindings?.value;

  return (
    <div className="space-y-1">
      {label && (
        <label className="ui-eyebrow text-xs text-muted-foreground">
          {label}
        </label>
      )}
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => bindPath && set(bindPath, e.target.value)}
        className={inputBase}
      />
    </div>
  );
};

export const Textarea: ComponentRenderer = ({ element, bindings }) => {
  const resolve = useI18nResolver();
  const placeholder = resolve(element.props?.placeholder);
  const label = resolve(element.props?.label);
  const value = (element.props?.value as string) ?? "";
  const rows = (element.props?.rows as number) ?? 8;
  const { set } = useStateStore();
  const bindPath = bindings?.value;

  return (
    <div className="space-y-1">
      {label && (
        <label className="ui-eyebrow text-xs text-muted-foreground">
          {label}
        </label>
      )}
      <textarea
        value={value}
        rows={rows}
        placeholder={placeholder}
        onChange={(e) => bindPath && set(bindPath, e.target.value)}
        className={clsx(
          inputBase,
          "min-h-[160px] resize-y font-mono leading-relaxed",
        )}
      />
    </div>
  );
};

export const SearchInput: ComponentRenderer = ({ element, bindings }) => {
  const resolve = useI18nResolver();
  const placeholder = resolve(element.props?.placeholder);
  const value = (element.props?.value as string) ?? "";
  const { set } = useStateStore();
  const bindPath = bindings?.value;
  const SearchIcon = Icons.Search;

  return (
    <div className="relative">
      <SearchIcon className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => bindPath && set(bindPath, e.target.value)}
        className={clsx(inputBase, "pl-7 pr-3")}
      />
    </div>
  );
};

export const Select: ComponentRenderer = ({ element, bindings }) => {
  const resolve = useI18nResolver();
  const label = resolve(element.props?.label);
  const value = (element.props?.value as string) ?? "";
  const options =
    (element.props?.options as Array<{ value: string; label: unknown }>) ?? [];
  const { set } = useStateStore();
  const bindPath = bindings?.value;

  return (
    <div className="space-y-1">
      {label && (
        <label className="ui-eyebrow text-xs text-muted-foreground">
          {label}
        </label>
      )}
      <select
        value={value}
        onChange={(e) => bindPath && set(bindPath, e.target.value)}
        className={inputBase}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {resolve(opt.label)}
          </option>
        ))}
      </select>
    </div>
  );
};

export const Switch: ComponentRenderer = ({ element, bindings }) => {
  const resolve = useI18nResolver();
  const label = resolve(element.props?.label);
  const checked = (element.props?.checked as boolean) ?? false;
  const { set } = useStateStore();
  const bindPath = bindings?.checked;

  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <div
        role="switch"
        aria-checked={checked}
        onClick={() => bindPath && set(bindPath, !checked)}
        className={clsx(
          "w-8 h-4.5 rounded-full transition-colors relative",
          checked ? "bg-primary" : "bg-muted",
        )}
      >
        <div
          className={clsx(
            "w-3.5 h-3.5 bg-background rounded-full absolute top-0.5 transition-transform shadow-sm",
            checked ? "translate-x-4" : "translate-x-0.5",
          )}
        />
      </div>
      <span className="text-xs text-foreground">{label}</span>
    </label>
  );
};

export const FilterBar: ComponentRenderer = ({ element, bindings }) => {
  const resolve = useI18nResolver();
  const options =
    (element.props?.options as Array<{
      value: string;
      label: unknown;
      icon?: string;
    }>) ?? [];
  const value = (element.props?.value as string) ?? "all";
  const { set } = useStateStore();
  const bindPath = bindings?.value;

  return (
    <div className="flex flex-wrap gap-1">
      {options.map((opt) => {
        const active = value === opt.value;
        const OptIcon = resolveIcon(opt.icon);
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => bindPath && set(bindPath, opt.value)}
            className={clsx(
              "inline-flex items-center gap-1 px-2 py-0.5 text-[10px] uppercase tracking-wider border rounded-sm transition-colors",
              "ui-chip",
              active
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-transparent text-muted-foreground border-border hover:border-foreground/40 hover:text-foreground",
            )}
          >
            {OptIcon && <OptIcon className="w-3 h-3" />}
            {resolve(opt.label)}
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
    | ((next: string) => void)
    | undefined;

  const colorAccents: Record<string, string> = {
    red: "border-red-500 text-red-600 dark:text-red-400",
    amber: "border-amber-500 text-amber-600 dark:text-amber-400",
    blue: "border-blue-500 text-blue-600 dark:text-blue-400",
    green: "border-green-500 text-green-600 dark:text-green-400",
    purple: "border-purple-500 text-purple-600 dark:text-purple-400",
    cyan: "border-cyan-500 text-cyan-600 dark:text-cyan-400",
  };

  return (
    <div
      role="tablist"
      className="flex flex-wrap gap-2 border-b border-border pb-1"
    >
      {tabs.map((tab) => {
        const active = value === tab.value;
        const TabIcon = resolveIcon(tab.icon);
        const accent = active && tab.color ? colorAccents[tab.color] : "";
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
