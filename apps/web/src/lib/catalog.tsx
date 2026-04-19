/**
 * Covel component catalog for json-render.
 *
 * These are the UI primitives available to plugin JSON specs.
 * Plugins can only use components registered here — the framework
 * controls the vocabulary, plugins compose from it.
 *
 * The Button selection feedback wires through the V1 session store's
 * `pendingInteractionDrafts` so plugin-declared click bindings echo back
 * a visual selection marker when the user picks a choice.
 */

import { useState, useMemo, type ReactNode } from "react";
import type { ComponentRenderer } from "@json-render/react";
import { useStateStore } from "@json-render/react";
import { clsx } from "clsx";
import * as Icons from "lucide-react";
import { GraphCanvas } from "./graph-canvas.js";
import {
  resolveActionParams,
  matchesPendingDraft,
} from "./interaction-selection.js";
import { useSession } from "@/stores/session-store.js";
import { WorldDimensionsPanel } from "@/components/session/world-dimensions-panel.js";

// ── Helpers ──────────────────────────────────────────────────────

export function resolveIcon(name: string | undefined): Icons.LucideIcon | null {
  if (!name) return null;
  // Convert kebab-case to PascalCase: "book-open" → "BookOpen"
  const pascal = name
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
  return (Icons as Record<string, unknown>)[pascal] as Icons.LucideIcon | undefined ?? null;
}

export function resolveI18n(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, string>;
    // Try zh first (default locale), then en, then first value
    return obj["zh"] ?? obj["zh-CN"] ?? obj["en"] ?? obj["en-US"] ?? Object.values(obj)[0] ?? "";
  }
  return String(value ?? "");
}

// ── Layout Components ────────────────────────────────────────────

const Stack: ComponentRenderer = ({ element, children }) => {
  const gap = element.props?.gap as string ?? "md";
  const gapClass = { xs: "gap-1", sm: "gap-2", md: "gap-3", lg: "gap-4" }[gap] ?? "gap-3";
  return <div className={clsx("flex flex-col", gapClass)}>{children}</div>;
};

const Row: ComponentRenderer = ({ element, children }) => {
  const gap = element.props?.gap as string ?? "sm";
  const align = element.props?.align as string ?? "center";
  const justify = element.props?.justify as string | undefined;
  const gapClass = { xs: "gap-1", sm: "gap-2", md: "gap-3", lg: "gap-4" }[gap] ?? "gap-2";
  const alignClass = { start: "items-start", center: "items-center", end: "items-end" }[align] ?? "items-center";
  const justifyClass = justify
    ? ({ start: "justify-start", center: "justify-center", end: "justify-end", between: "justify-between", around: "justify-around" }[justify] ?? "")
    : "";
  return <div className={clsx("flex flex-row", gapClass, alignClass, justifyClass)}>{children}</div>;
};

const Grid: ComponentRenderer = ({ element, children }) => {
  const cols = element.props?.cols as number ?? 2;
  return (
    <div className={clsx("grid gap-3", {
      "grid-cols-1": cols === 1,
      "grid-cols-2": cols === 2,
      "grid-cols-3": cols === 3,
      "grid-cols-4": cols === 4,
    })}>
      {children}
    </div>
  );
};

const Separator: ComponentRenderer = () => (
  <hr className="border-t border-zinc-200 dark:border-zinc-700 my-2" />
);

// ── Display Components ───────────────────────────────────────────

const Text: ComponentRenderer = ({ element, children }) => {
  const content = resolveI18n(element.props?.content) || (typeof children === "string" ? children : "");
  const variant = element.props?.variant as string;
  const weight = element.props?.weight as string;
  const size = element.props?.size as string;
  const align = element.props?.align as string;

  return (
    <p className={clsx(
      "leading-relaxed",
      variant === "muted" && "text-zinc-500 dark:text-zinc-400",
      weight === "bold" && "font-semibold",
      size === "xs" && "text-[10px]",
      size === "sm" && "text-xs",
      size === "lg" && "text-lg",
      align === "center" && "text-center",
    )}>
      {content || children}
    </p>
  );
};

const Badge: ComponentRenderer = ({ element }) => {
  const label = resolveI18n(element.props?.label);
  const color = element.props?.color as string;
  const colorMap: Record<string, string> = {
    red: "bg-red-500/10 text-red-600 border-red-500/30",
    amber: "bg-amber-500/10 text-amber-600 border-amber-500/30",
    blue: "bg-blue-500/10 text-blue-600 border-blue-500/30",
    green: "bg-green-500/10 text-green-600 border-green-500/30",
    purple: "bg-purple-500/10 text-purple-600 border-purple-500/30",
    cyan: "bg-cyan-500/10 text-cyan-600 border-cyan-500/30",
  };
  return (
    <span className={clsx(
      "inline-flex items-center px-1.5 py-0.5 text-[10px] border rounded-sm",
      colorMap[color ?? ""] ?? "bg-zinc-500/10 text-zinc-600 border-zinc-500/30",
    )}>
      {label}
    </span>
  );
};

const Icon: ComponentRenderer = ({ element }) => {
  const name = element.props?.name as string;
  const size = element.props?.size as string ?? "sm";
  const LucideIcon = resolveIcon(name);
  if (!LucideIcon) return null;
  const sizeClass = { xs: "w-3 h-3", sm: "w-4 h-4", md: "w-5 h-5", lg: "w-6 h-6" }[size] ?? "w-4 h-4";
  return <LucideIcon className={sizeClass} />;
};

const TagList: ComponentRenderer = ({ element }) => {
  const tags = element.props?.tags as string[];
  if (!tags || tags.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {tags.map((tag) => (
        <span key={tag} className="text-[9px] px-1.5 py-0.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 rounded-sm">
          {tag}
        </span>
      ))}
    </div>
  );
};

// ── Data Components ──────────────────────────────────────────────

const Card: ComponentRenderer = ({ element, children }) => {
  const variant = element.props?.variant as string;
  return (
    <div className={clsx(
      "border border-zinc-200 dark:border-zinc-700 rounded-md p-3",
      variant === "glow" && "shadow-lg shadow-amber-500/20 border-amber-500/50",
      variant === "subtle" && "bg-zinc-50/70 dark:bg-zinc-900/30",
    )}>
      {children}
    </div>
  );
};

const CardList: ComponentRenderer = ({ children }) => {
  return <div className="space-y-2">{children}</div>;
};

const EntryCard: ComponentRenderer = ({ element }) => {
  const title = resolveI18n(element.props?.title);
  const category = element.props?.category as string ?? "";
  const content = resolveI18n(element.props?.content);
  const tags = element.props?.tags as string[] | undefined;
  const rarity = element.props?.rarity as string ?? "common";
  // Optional plugin-supplied per-category icon + color (e.g. from a
  // plugin's categoryMeta payload). When provided they override the
  // built-in fallback map below; when missing the card still renders
  // sensibly via the fallback so pre-enrichment entries keep working.
  const externalIcon = element.props?.icon as string | undefined;
  const externalColor = element.props?.color as string | undefined;
  // Generic feature flags — any plugin can set these via itemLiteralProps
  // or itemPropMap. collapsible toggles a chevron that hides body/tags;
  // isNew renders a purple "NEW" sparkle next to the title.
  const collapsible = element.props?.collapsible as boolean ?? false;
  const defaultExpanded = element.props?.defaultExpanded as boolean ?? true;
  const isNew = element.props?.isNew as boolean ?? false;

  const [expanded, setExpanded] = useState(defaultExpanded);

  const categoryIcons: Record<string, string> = {
    monster: "skull", item: "gem", location: "map-pin",
    lore: "scroll-text", character: "users", skill: "sparkles",
  };
  const rarityColors: Record<string, string> = {
    legendary: "border-l-amber-500", rare: "border-l-purple-500",
    uncommon: "border-l-blue-500", common: "border-l-zinc-400",
  };
  const rarityBadgeColors: Record<string, string> = {
    legendary: "bg-amber-500/10 text-amber-600 border-amber-500/30",
    rare: "bg-purple-500/10 text-purple-600 border-purple-500/30",
    uncommon: "bg-blue-500/10 text-blue-600 border-blue-500/30",
    common: "bg-zinc-500/10 text-zinc-600 border-zinc-500/30",
  };
  const categoryIconColors: Record<string, string> = {
    red: "text-red-500 dark:text-red-400",
    amber: "text-amber-500 dark:text-amber-400",
    blue: "text-blue-500 dark:text-blue-400",
    green: "text-green-500 dark:text-green-400",
    purple: "text-purple-500 dark:text-purple-400",
    cyan: "text-cyan-500 dark:text-cyan-400",
  };

  const CategoryIcon = resolveIcon(externalIcon ?? categoryIcons[category] ?? "book-open");
  const iconColorClass = externalColor ? categoryIconColors[externalColor] ?? "text-zinc-500" : "text-zinc-500";
  const Chevron = expanded ? Icons.ChevronDown : Icons.ChevronRight;
  const SparkleIcon = Icons.Sparkles;

  const showBody = !collapsible || expanded;
  const titleRowClass = clsx(
    "flex items-center gap-2",
    collapsible && "cursor-pointer select-none",
  );

  return (
    <div className={clsx("border border-zinc-200 dark:border-zinc-700 rounded-md p-2.5 border-l-2 space-y-1.5", rarityColors[rarity])}>
      <div
        className={titleRowClass}
        onClick={collapsible ? () => setExpanded((v) => !v) : undefined}
        role={collapsible ? "button" : undefined}
        tabIndex={collapsible ? 0 : undefined}
        aria-expanded={collapsible ? expanded : undefined}
        onKeyDown={collapsible ? (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        } : undefined}
      >
        {collapsible && (
          <Chevron className="w-3 h-3 shrink-0 text-zinc-500" aria-hidden="true" />
        )}
        {CategoryIcon && <CategoryIcon className={clsx("w-3.5 h-3.5 shrink-0", iconColorClass)} />}
        <span className="text-xs font-medium flex-1 truncate">{title}</span>
        {isNew && (
          <span
            className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[9px] font-semibold tracking-wider uppercase text-purple-600 dark:text-purple-300 bg-purple-500/10 border border-purple-500/30 rounded-sm"
            aria-label="new"
          >
            <SparkleIcon className="w-2.5 h-2.5" />
            NEW
          </span>
        )}
        <span className={clsx("inline-flex items-center px-1.5 py-0.5 text-[10px] border rounded-sm", rarityBadgeColors[rarity])}>
          {category}
        </span>
      </div>
      {showBody && content && <p className="text-[11px] text-zinc-500 dark:text-zinc-400 leading-relaxed">{content}</p>}
      {showBody && tags && tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {tags.map((tag) => (
            <span key={tag} className="text-[9px] px-1.5 py-0.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 rounded-sm">
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
};

const StatBar: ComponentRenderer = ({ element }) => {
  const label = resolveI18n(element.props?.label);
  const value = element.props?.value as number ?? 0;
  const max = element.props?.max as number ?? 100;
  const pct = Math.min(100, Math.max(0, (value / max) * 100));

  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-zinc-500">{label}</span>
        <span className="font-mono">{value}/{max}</span>
      </div>
      <div className="h-1.5 bg-zinc-200 dark:bg-zinc-700 rounded-full overflow-hidden">
        <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
};

const Progress: ComponentRenderer = ({ element }) => {
  const value = element.props?.value as number ?? 0;
  const max = element.props?.max as number ?? 100;
  const label = resolveI18n(element.props?.label);
  const pct = Math.min(100, Math.max(0, (value / max) * 100));

  return (
    <div className="space-y-1">
      {label && <span className="text-xs text-zinc-500">{label}</span>}
      <div className="h-2 bg-zinc-200 dark:bg-zinc-700 rounded-full overflow-hidden">
        <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
};

// ── Collapsible / Recursive JSON ─────────────────────────────────

/**
 * Accordion — vertical list wrapper for Section children.
 * No own behavior; just groups collapsible sections with consistent spacing.
 */
const Accordion: ComponentRenderer = ({ children }) => (
  <div className="space-y-0.5">{children}</div>
);

/**
 * Section — collapsible header + content block.
 * Self-contained open state; receives title/icon via props, body via children.
 */
const Section: ComponentRenderer = ({ element, children }) => {
  const title = resolveI18n(element.props?.title);
  const iconName = element.props?.icon as string | undefined;
  const defaultOpen = element.props?.defaultOpen as boolean ?? false;
  const [open, setOpen] = useState(defaultOpen);
  const SectionIcon = resolveIcon(iconName);
  const Chevron = Icons.ChevronRight;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
      >
        <Chevron className={clsx("w-3 h-3 transition-transform shrink-0", open && "rotate-90")} />
        {SectionIcon && <SectionIcon className="w-3 h-3 shrink-0" />}
        <span className="truncate text-left">{title}</span>
      </button>
      {open && (
        <div className="border-l border-zinc-200 dark:border-zinc-700 pl-3 ml-1.5 space-y-1 pb-2 pt-0.5">
          {children}
        </div>
      )}
    </div>
  );
};

/**
 * Render any JSON value with shape-aware styling.
 * Primitives inline, arrays of primitives as tag list, arrays of objects
 * as vertical list, nested objects as key: value pairs.
 */
function renderJsonValue(value: unknown, depth: number): ReactNode {
  if (value === null || value === undefined) {
    return <span className="text-zinc-400 italic text-[10px]">—</span>;
  }
  if (typeof value === "string") {
    return <span className="text-[11px] text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap">{value}</span>;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return <span className="text-[11px] font-mono text-blue-600 dark:text-blue-400">{String(value)}</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span className="text-zinc-400 italic text-[10px]">[ ]</span>;
    }
    const allPrimitive = value.every(
      (v) => v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean",
    );
    if (allPrimitive) {
      return (
        <div className="flex flex-wrap gap-1">
          {value.map((v, i) => (
            <span key={i} className="text-[9px] px-1.5 py-0.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 rounded-sm">
              {String(v)}
            </span>
          ))}
        </div>
      );
    }
    return (
      <div className="space-y-1.5">
        {value.map((item, i) => (
          <div key={i} className="border-l border-zinc-200 dark:border-zinc-800 pl-2">
            {renderJsonValue(item, depth + 1)}
          </div>
        ))}
      </div>
    );
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      return <span className="text-zinc-400 italic text-[10px]">{"{ }"}</span>;
    }
    return (
      <div className={clsx("space-y-0.5", depth > 0 && "mt-0.5")}>
        {entries.map(([k, v]) => {
          const isNested = v !== null && typeof v === "object";
          return (
            <div key={k} className="text-[11px] leading-snug">
              <span className="text-zinc-500 dark:text-zinc-400 font-medium">{k}</span>
              <span className="text-zinc-400">: </span>
              {isNested ? (
                <div className="pl-2 mt-0.5">{renderJsonValue(v, depth + 1)}</div>
              ) : (
                renderJsonValue(v, depth + 1)
              )}
            </div>
          );
        })}
      </div>
    );
  }
  return <span className="text-[11px]">{String(value)}</span>;
}

/**
 * JsonView — renders any JSON value passed via props.value.
 * Used inside repeat blocks with `value: { "$bindItem": "/value" }`
 * to display arbitrary plugin-data shapes without per-shape specs.
 */
const JsonView: ComponentRenderer = ({ element }) => {
  const value = element.props?.value;
  return <div className="text-[11px]">{renderJsonValue(value, 0)}</div>;
};

// ── Interactive Components ───────────────────────────────────────

const Button: ComponentRenderer = ({ element, emit }) => {
  const label = resolveI18n(element.props?.label);
  const variant = element.props?.variant as string ?? "default";
  const size = element.props?.size as string ?? "md";

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

  return (
    <button
      type="button"
      onClick={() => emit("click")}
      aria-pressed={isSelected || undefined}
      data-selected={isSelected ? "true" : undefined}
      className={clsx(
        "font-medium rounded-md transition-all text-left relative",
        size === "compact" ? "px-2.5 py-1 text-[11px]" : "px-3 py-1.5 text-xs",
        // Base variant styles — applied only when NOT selected.
        !isSelected && variant === "primary" && "bg-blue-600 text-white hover:bg-blue-700",
        !isSelected && variant === "default" && "bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700",
        !isSelected && variant === "ghost" && "bg-white/70 dark:bg-zinc-950/40 border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-900",
        !isSelected && variant === "danger" && "bg-red-600 text-white hover:bg-red-700",
        // Selected state — distinct from every variant so the pick is obvious.
        isSelected && "bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-200 border border-blue-500 dark:border-blue-400 ring-2 ring-blue-500/40 dark:ring-blue-400/30 shadow-sm",
      )}
    >
      {isSelected && (
        <span
          aria-hidden="true"
          className="inline-block mr-1.5 text-blue-600 dark:text-blue-300"
        >
          ✓
        </span>
      )}
      {label}
    </button>
  );
};

const Input: ComponentRenderer = ({ element, bindings }) => {
  const placeholder = resolveI18n(element.props?.placeholder);
  const label = resolveI18n(element.props?.label);
  const value = element.props?.value as string ?? "";
  const { set } = useStateStore();
  const bindPath = bindings?.value;

  return (
    <div className="space-y-1">
      {label && <label className="text-xs text-zinc-500">{label}</label>}
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => bindPath && set(bindPath, e.target.value)}
        className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 px-2.5 py-1.5 text-xs rounded-md outline-none focus:ring-1 focus:ring-blue-500"
      />
    </div>
  );
};

const SearchInput: ComponentRenderer = ({ element, bindings }) => {
  const placeholder = resolveI18n(element.props?.placeholder);
  const value = element.props?.value as string ?? "";
  const { set } = useStateStore();
  const bindPath = bindings?.value;
  const SearchIcon = Icons.Search;

  return (
    <div className="relative">
      <SearchIcon className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-400" />
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => bindPath && set(bindPath, e.target.value)}
        className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 pl-7 pr-3 py-1.5 text-xs rounded-md outline-none focus:ring-1 focus:ring-blue-500"
      />
    </div>
  );
};

const Select: ComponentRenderer = ({ element, bindings }) => {
  const label = resolveI18n(element.props?.label);
  const value = element.props?.value as string ?? "";
  const options = element.props?.options as Array<{ value: string; label: unknown }> ?? [];
  const { set } = useStateStore();
  const bindPath = bindings?.value;

  return (
    <div className="space-y-1">
      {label && <label className="text-xs text-zinc-500">{label}</label>}
      <select
        value={value}
        onChange={(e) => bindPath && set(bindPath, e.target.value)}
        className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 px-2.5 py-1.5 text-xs rounded-md outline-none focus:ring-1 focus:ring-blue-500"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>{resolveI18n(opt.label)}</option>
        ))}
      </select>
    </div>
  );
};

const Switch: ComponentRenderer = ({ element, bindings }) => {
  const label = resolveI18n(element.props?.label);
  const checked = element.props?.checked as boolean ?? false;
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
          checked ? "bg-blue-600" : "bg-zinc-300 dark:bg-zinc-600",
        )}
      >
        <div className={clsx(
          "w-3.5 h-3.5 bg-white rounded-full absolute top-0.5 transition-transform",
          checked ? "translate-x-4" : "translate-x-0.5",
        )} />
      </div>
      <span className="text-xs">{label}</span>
    </label>
  );
};

const FilterBar: ComponentRenderer = ({ element, bindings }) => {
  const options = element.props?.options as Array<{ value: string; label: unknown; icon?: string }> ?? [];
  const value = element.props?.value as string ?? "all";
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
              active
                ? "bg-zinc-900 text-white border-zinc-900 dark:bg-white dark:text-zinc-900 dark:border-white"
                : "bg-transparent text-zinc-500 border-zinc-200 dark:border-zinc-700 hover:border-zinc-400",
            )}
          >
            {OptIcon && <OptIcon className="w-3 h-3" />}
            {resolveI18n(opt.label)}
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
 * Resolve a slash- or dot-delimited path against an object/array.
 * Returns undefined for missing segments. Numeric segments index arrays.
 */
function resolvePath(value: unknown, path: string): unknown {
  if (!path) return value;
  const segments = path.split(/[/.]/).filter((s) => s.length > 0);
  let current: unknown = value;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isNaN(index) ? undefined : current[index];
      continue;
    }
    if (typeof current === "object") {
      current = (current as Record<string, unknown>)[segment];
      continue;
    }
    return undefined;
  }
  return current;
}

/**
 * Flatten a value to a single string used for substring matching.
 * Strings stay as-is; arrays join their primitive members; objects are
 * stringified with their entry values (keys ignored).
 */
function valueToHaystack(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(valueToHaystack).join(" ");
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).map(valueToHaystack).join(" ");
  }
  return "";
}

interface FilterTab {
  value: string;
  label?: unknown;
  icon?: string;
  color?: string;
}

/**
 * Filter an items array against a search query and an active tab value.
 * Exported in test-only form via __testables (see bottom of file) so the
 * filter logic can be unit-tested without driving React.
 */
function filterItems(
  items: unknown[],
  searchQuery: string,
  searchFields: string[],
  filterField: string | undefined,
  activeFilter: string,
): unknown[] {
  const query = searchQuery.trim().toLowerCase();
  return items.filter((item) => {
    if (filterField && activeFilter && activeFilter !== "all") {
      const fieldValue = resolvePath(item, filterField);
      if (String(fieldValue ?? "") !== activeFilter) return false;
    }
    if (query.length > 0) {
      const haystack = searchFields
        .map((field) => valueToHaystack(resolvePath(item, field)))
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

/**
 * Tabs — visual tab strip with optional icon + color accent.
 * Standalone usage binds the active value via `$bindState`; FilterContainer
 * uses it as a controlled child driven by local React state.
 *
 * Optional `counts: Record<string, number>` suffixes each tab label with
 * `(N)` where N is `counts[tab.value] ?? 0`. Zero values still render,
 * which gives an honest "empty tab" signal instead of hiding it.
 */
const Tabs: ComponentRenderer = ({ element, bindings }) => {
  const tabs = (element.props?.tabs as FilterTab[]) ?? [];
  const value = element.props?.value as string ?? tabs[0]?.value ?? "";
  const counts = element.props?.counts as Record<string, number> | undefined;
  const { set } = useStateStore();
  const bindPath = bindings?.value;
  const onChange = element.props?.__onChange as ((next: string) => void) | undefined;

  const colorAccents: Record<string, string> = {
    red: "border-red-500 text-red-600 dark:text-red-400",
    amber: "border-amber-500 text-amber-600 dark:text-amber-400",
    blue: "border-blue-500 text-blue-600 dark:text-blue-400",
    green: "border-green-500 text-green-600 dark:text-green-400",
    purple: "border-purple-500 text-purple-600 dark:text-purple-400",
    cyan: "border-cyan-500 text-cyan-600 dark:text-cyan-400",
  };

  return (
    <div role="tablist" className="flex flex-wrap gap-1 border-b border-zinc-200 dark:border-zinc-800 pb-1">
      {tabs.map((tab) => {
        const active = value === tab.value;
        const TabIcon = resolveIcon(tab.icon);
        const accent = active && tab.color ? colorAccents[tab.color] : "";
        const count = counts ? counts[tab.value] ?? 0 : undefined;
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
              active
                ? clsx("font-semibold", accent || "border-zinc-900 dark:border-zinc-100 text-zinc-900 dark:text-zinc-100")
                : "border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200",
            )}
          >
            {TabIcon && <TabIcon className="w-3 h-3" />}
            {resolveI18n(tab.label)}
            {count !== undefined && (
              <span className="text-[10px] text-zinc-400 dark:text-zinc-500 ml-0.5">({count})</span>
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
const FilterContainer: ComponentRenderer = ({ element }) => {
  const items = (element.props?.items as unknown[]) ?? [];
  const searchPlaceholder = resolveI18n(element.props?.searchPlaceholder);
  const searchFields = (element.props?.searchFields as string[]) ?? [];
  const filterField = element.props?.filterField as string | undefined;
  const filterTabs = (element.props?.filterTabs as FilterTab[]) ?? [];
  const itemComponent = element.props?.itemComponent as string | undefined;
  const itemPropMap = (element.props?.itemPropMap as Record<string, string>) ?? {};
  // itemLiteralProps — flat literal values forwarded verbatim to every item
  // instance. Useful for "apply this to all items" switches like `collapsible`.
  // Path-based `itemPropMap` wins on collisions.
  const itemLiteralProps = (element.props?.itemLiteralProps as Record<string, unknown>) ?? {};
  const itemKeyField = element.props?.itemKeyField as string | undefined;
  const emptyMessage = resolveI18n(element.props?.emptyMessage);
  const showSearch = element.props?.showSearch !== false && searchFields.length > 0;
  const showTabs = element.props?.showTabs !== false && filterTabs.length > 0;
  const showCounts = element.props?.showCounts as boolean ?? false;
  const footerRaw = element.props?.footer;

  const initialFilter = filterTabs[0]?.value ?? "all";
  const [searchQuery, setSearchQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState(initialFilter);

  const itemsArray = Array.isArray(items) ? items : [];

  const filtered = useMemo(
    () => filterItems(itemsArray, searchQuery, searchFields, filterField, activeFilter),
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
      const fieldValue = filterField ? resolvePath(item, filterField) : undefined;
      const key = String(fieldValue ?? "");
      for (const tab of filterTabs) {
        if (tab.value === "all" || tab.value === key) {
          counts[tab.value] = (counts[tab.value] ?? 0) + 1;
        }
      }
    }
    return counts;
  }, [showCounts, itemsArray, filterField, filterTabs]);

  const ItemComponent = itemComponent ? covelRegistry[itemComponent] : undefined;
  const SearchIcon = Icons.Search;

  const fallbackEmpty = filterField || searchQuery
    ? "没有匹配的条目"
    : "暂无数据";

  return (
    <div className="flex flex-col gap-2">
      {showSearch && (
        <div className="relative">
          <SearchIcon className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-400" />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder || "search"}
            className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 pl-7 pr-3 py-1.5 text-xs rounded-md outline-none focus:ring-1 focus:ring-blue-500"
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
          on={() => ({ emit: () => {}, shouldPreventDefault: false, bound: false })}
        />
      )}
      <div className="flex flex-col gap-2">
        {filtered.length === 0 && (
          <p className="text-xs text-zinc-400 italic text-center py-4">
            {emptyMessage || fallbackEmpty}
          </p>
        )}
        {filtered.length > 0 && ItemComponent && filtered.map((item, index) => {
          const itemProps: Record<string, unknown> = { ...itemLiteralProps };
          for (const [propName, itemPath] of Object.entries(itemPropMap)) {
            itemProps[propName] = resolvePath(item, itemPath);
          }
          const keyValue = itemKeyField ? resolvePath(item, itemKeyField) : undefined;
          const reactKey = keyValue !== undefined && keyValue !== null
            ? String(keyValue)
            : String(index);
          return (
            <ItemComponent
              key={reactKey}
              element={{ type: itemComponent ?? "EntryCard", props: itemProps }}
              emit={() => {}}
              on={() => ({ emit: () => {}, shouldPreventDefault: false, bound: false })}
            />
          );
        })}
        {filtered.length > 0 && !ItemComponent && (
          <p className="text-xs text-red-500 italic">
            FilterContainer: itemComponent &quot;{itemComponent}&quot; not found in registry
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
  if (typeof footer === "object" && footer !== null && !Array.isArray(footer)) {
    const obj = footer as Record<string, unknown>;
    const componentName = obj.component as string | undefined;
    if (componentName) {
      const Component = covelRegistry[componentName];
      if (!Component) {
        return (
          <p className="text-xs text-red-500 italic">
            FilterContainer footer: component &quot;{componentName}&quot; not found
          </p>
        );
      }
      const props = (obj.props as Record<string, unknown>) ?? {};
      return (
        <Component
          element={{ type: componentName, props }}
          emit={() => {}}
          on={() => ({ emit: () => {}, shouldPreventDefault: false, bound: false })}
        />
      );
    }
  }
  // Treat as i18n string (string or {zh, en} map). Substitute `{{count}}`
  // with the total item count as a convenience for spec authors.
  const raw = resolveI18n(footer);
  const rendered = raw.replace(/\{\{\s*count\s*\}\}/g, String(totalCount));
  if (!rendered) return null;
  return (
    <p className="text-[11px] text-zinc-500 dark:text-zinc-400 text-center pt-1 border-t border-zinc-200/60 dark:border-zinc-800/60">
      {rendered}
    </p>
  );
}

/**
 * Test-only export of internal pure helpers. Not part of the public catalog.
 * Exposed so unit tests can exercise filter logic without driving React.
 */
export const __filterContainerInternals = {
  resolvePath,
  valueToHaystack,
  filterItems,
};

// ── Message Components (for chat area rendering) ─────────────────

/** Prose — renders narrative text as styled paragraphs. */
const Prose: ComponentRenderer = ({ element }) => {
  const content = element.props?.content as string ?? "";
  const paragraphs = content.split(/\n\n+/).filter(Boolean);

  return (
    <div className="space-y-3">
      {paragraphs.map((p, i) => (
        <p key={i} className="text-sm text-zinc-800 dark:text-zinc-200 leading-relaxed">
          {p.split(/(\*\*[^*]+\*\*)/).map((segment, j) =>
            segment.startsWith("**") && segment.endsWith("**")
              ? <strong key={j} className="font-semibold">{segment.slice(2, -2)}</strong>
              : segment
          )}
        </p>
      ))}
    </div>
  );
};

/** PlayerMessage — renders player's input message (right-aligned bubble). */
const PlayerMessage: ComponentRenderer = ({ element }) => {
  const content = element.props?.content as string ?? "";
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] bg-blue-600 text-white px-4 py-2.5 rounded-2xl rounded-br-sm text-sm leading-relaxed">
        {content}
      </div>
    </div>
  );
};

/** Alert — renders notifications (info, success, warning, error). */
const Alert: ComponentRenderer = ({ element }) => {
  const level = element.props?.level as string ?? "info";
  const title = resolveI18n(element.props?.title);
  const message = resolveI18n(element.props?.message);

  const colors: Record<string, string> = {
    success: "border-emerald-500/30 bg-emerald-50 dark:bg-emerald-900/10 text-emerald-700 dark:text-emerald-400",
    warning: "border-amber-500/30 bg-amber-50 dark:bg-amber-900/10 text-amber-700 dark:text-amber-400",
    error: "border-red-500/30 bg-red-50 dark:bg-red-900/10 text-red-700 dark:text-red-400",
    info: "border-blue-500/30 bg-blue-50 dark:bg-blue-900/10 text-blue-700 dark:text-blue-400",
  };

  return (
    <div className={clsx("border rounded-lg px-4 py-2.5 text-sm", colors[level])}>
      {title && <div className="font-medium text-xs">{title}</div>}
      {message && <div className="text-xs mt-0.5 opacity-80">{message}</div>}
    </div>
  );
};

/** FormField — a single form field (text input or select). */
const FormField: ComponentRenderer = ({ element, bindings }) => {
  const fieldType = element.props?.fieldType as string ?? "text";
  const label = resolveI18n(element.props?.label);
  const placeholder = resolveI18n(element.props?.placeholder);
  const required = element.props?.required as boolean;
  const options = element.props?.options as Array<{ value: string; label: string }> | undefined;
  const value = element.props?.value as string ?? "";
  const disabled = element.props?.disabled as boolean;
  const { set } = useStateStore();
  const bindPath = bindings?.value;

  return (
    <div className="space-y-1">
      <label className="text-xs text-zinc-500">
        {label}
        {required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      {fieldType === "select" && options ? (
        <select
          value={value}
          onChange={(e) => bindPath && set(bindPath, e.target.value)}
          disabled={disabled}
          className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 px-3 py-1.5 text-sm rounded-md outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
        >
          <option value="">{placeholder ?? `选择${label}`}</option>
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => bindPath && set(bindPath, e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 px-3 py-1.5 text-sm rounded-md outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
        />
      )}
    </div>
  );
};

/** SubmitButton — styled form submit button with disabled state. */
const SubmitButton: ComponentRenderer = ({ element, emit }) => {
  const label = resolveI18n(element.props?.label);
  const disabled = element.props?.disabled as boolean;

  return (
    <button
      type="button"
      onClick={() => emit("click")}
      disabled={disabled}
      className={clsx(
        "w-full py-2.5 text-sm font-medium rounded-md transition-colors",
        disabled
          ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-400 cursor-not-allowed"
          : "bg-blue-600 text-white hover:bg-blue-700",
      )}
    >
      {label}
    </button>
  );
};

/** Source — subtle source attribution label. */
const Source: ComponentRenderer = ({ element }) => {
  const label = element.props?.label as string ?? "";
  return <span className="text-[9px] text-zinc-400 block mt-1">{label}</span>;
};

/**
 * WorldDimensions — renders the current world's structured dimensions
 * (geography, factions, powerSystem, history, economy, tone, mechanics)
 * via the reusable WorldDimensionsPanel. Reads directly from session
 * context; no data bindings required from the plugin spec.
 *
 * Falls back to a muted empty-state message when the world has no
 * dimensions attached (e.g. pre-generation).
 */
const WorldDimensions: ComponentRenderer = () => {
  const { state } = useSession();
  const dims = state.world?.dimensions;
  if (!dims) {
    return (
      <p className="text-xs text-muted-foreground italic">
        尚未生成世界维度数据。
      </p>
    );
  }
  return <WorldDimensionsPanel dimensions={dims} />;
};

// ── Form Components ──────────────────────────────────────────────

const Form: ComponentRenderer = ({ children }) => {
  return (
    <div className="border border-zinc-200 dark:border-zinc-700 rounded-lg overflow-hidden">
      <div className="p-4 space-y-3">{children}</div>
    </div>
  );
};

/** FormHeader — form title bar. */
const FormHeader: ComponentRenderer = ({ element }) => {
  const title = resolveI18n(element.props?.title);
  return (
    <div className="bg-zinc-50 dark:bg-zinc-800/50 px-4 py-2 -mx-4 -mt-4 mb-3 border-b border-zinc-200 dark:border-zinc-700">
      <span className="text-xs font-medium">{title}</span>
    </div>
  );
};

// ── Registry ─────────────────────────────────────────────────────

export const covelRegistry: Record<string, ComponentRenderer> = {
  // Layout
  Stack,
  Row,
  Grid,
  Separator,
  // Display
  Text,
  Badge,
  Icon,
  TagList,
  Source,
  // Data
  Card,
  CardList,
  EntryCard,
  StatBar,
  Progress,
  Accordion,
  Section,
  JsonView,
  // Interactive
  Button,
  Input,
  SearchInput,
  Select,
  Switch,
  FilterBar,
  Tabs,
  FilterContainer,
  // Form
  Form,
  FormHeader,
  FormField,
  SubmitButton,
  // Message (chat area)
  Prose,
  PlayerMessage,
  Alert,
  // Visualization
  GraphCanvas,
  WorldDimensions,
};
