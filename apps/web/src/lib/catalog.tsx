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

import { useState, useMemo, useCallback, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import i18nInstance from "@/i18n";
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

/**
 * Resolve an `I18nText`-shaped value (`string | Record<locale, string>`) to a
 * plain string, honoring the current i18n locale.
 *
 * Match order: exact locale (`zh-CN`) → prefix match (`zh-CN` → `zh`) →
 * English fallbacks (`en-US`/`en`) → any available value → empty string.
 *
 * When no locale is passed, the current `i18next` language is read at call
 * time. Components that render `resolveI18n(...)` output should also call
 * `useI18nResolver()` to subscribe to language changes and re-render.
 */
export function resolveI18n(value: unknown, locale?: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, string>;
    const lang = locale ?? i18nInstance.language ?? "";
    if (lang && obj[lang]) return obj[lang];
    const prefix = lang.split("-")[0];
    if (prefix) {
      const prefixMatch = Object.keys(obj).find((k) => k === prefix || k.startsWith(`${prefix}-`));
      if (prefixMatch && obj[prefixMatch]) return obj[prefixMatch];
    }
    return obj["en-US"] ?? obj["en"] ?? Object.values(obj)[0] ?? "";
  }
  return String(value ?? "");
}

/**
 * React hook returning a memoised resolver bound to the current i18n locale.
 * Using this inside a `ComponentRenderer` ensures the component re-renders
 * when the user toggles language, because `useTranslation()` subscribes to
 * language-change events through the react-i18next provider.
 */
export function useI18nResolver(): (value: unknown) => string {
  const { i18n } = useTranslation();
  return useCallback((value: unknown) => resolveI18n(value, i18n.language), [i18n.language]);
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
  <hr className="border-t border-border my-2 paper:border-dashed paper:opacity-70" />
);

// ── Display Components ───────────────────────────────────────────

const Text: ComponentRenderer = ({ element, children }) => {
  const resolve = useI18nResolver();
  const content = resolve(element.props?.content) || (typeof children === "string" ? children : "");
  const variant = element.props?.variant as string;
  const weight = element.props?.weight as string;
  const size = element.props?.size as string;
  const align = element.props?.align as string;

  return (
    <p className={clsx(
      "leading-relaxed text-foreground",
      variant === "muted" && "text-muted-foreground",
      weight === "bold" && "font-semibold paper:font-medium",
      size === "xs" && "text-[10px]",
      size === "sm" && "text-xs",
      size === "lg" && "text-lg paper:font-serif paper:italic paper:font-normal",
      align === "center" && "text-center",
    )}>
      {content || children}
    </p>
  );
};

const Badge: ComponentRenderer = ({ element }) => {
  const resolve = useI18nResolver();
  const label = resolve(element.props?.label);
  const color = element.props?.color as string;
  // Status colors keep their semantic hue; Paper dials saturation down via
  // a softer background so it still reads as a tag, not an alarm.
  const colorMap: Record<string, string> = {
    red: "bg-red-500/10 text-red-600 border-red-500/30 paper:bg-red-500/15 paper:text-red-500/90",
    amber: "bg-amber-500/10 text-amber-600 border-amber-500/30 paper:bg-amber-500/15 paper:text-amber-600/90",
    blue: "bg-blue-500/10 text-blue-600 border-blue-500/30 paper:bg-blue-500/15 paper:text-blue-500/90",
    green: "bg-green-500/10 text-green-600 border-green-500/30 paper:bg-green-500/15 paper:text-green-600/90",
    purple: "bg-purple-500/10 text-purple-600 border-purple-500/30 paper:bg-purple-500/15 paper:text-purple-500/90",
    cyan: "bg-cyan-500/10 text-cyan-600 border-cyan-500/30 paper:bg-cyan-500/15 paper:text-cyan-600/90",
  };
  return (
    <span className={clsx(
      "inline-flex items-center px-1.5 py-0.5 text-[10px] border rounded-sm",
      // Paper badges lean mono + pill, echoing Variant A's RtChip style.
      "paper:rounded-full paper:font-mono paper:tracking-[0.04em] paper:px-2 paper:uppercase",
      colorMap[color ?? ""] ?? "bg-muted text-muted-foreground border-border",
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
        <span
          key={tag}
          className="text-[9px] px-1.5 py-0.5 bg-muted text-muted-foreground rounded-sm paper:rounded-full paper:border paper:border-border paper:bg-transparent paper:font-mono paper:tracking-[0.04em] paper:px-2"
        >
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
      "border border-border rounded-md p-3 bg-card/60 paper:bg-card paper:rounded-lg",
      variant === "glow" && "shadow-lg shadow-amber-500/20 border-amber-500/50 paper:shadow-none paper:border-[color:var(--color-primary)]/50",
      variant === "subtle" && "bg-muted/40 paper:bg-card/40 paper:border-dashed",
    )}>
      {children}
    </div>
  );
};

const CardList: ComponentRenderer = ({ children }) => {
  return <div className="space-y-2">{children}</div>;
};

const EntryCard: ComponentRenderer = ({ element }) => {
  const resolve = useI18nResolver();
  const title = resolve(element.props?.title);
  const category = element.props?.category as string ?? "";
  const content = resolve(element.props?.content);
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
  // Rarity accent — keeps semantic color in Modern; Paper dims saturation.
  const rarityColors: Record<string, string> = {
    legendary: "border-l-amber-500 paper:border-l-[color:var(--color-primary)]",
    rare: "border-l-purple-500 paper:border-l-purple-500/70",
    uncommon: "border-l-blue-500 paper:border-l-blue-500/60",
    common: "border-l-border paper:border-l-border",
  };
  const rarityBadgeColors: Record<string, string> = {
    legendary: "bg-amber-500/10 text-amber-600 border-amber-500/30 paper:bg-amber-500/15",
    rare: "bg-purple-500/10 text-purple-600 border-purple-500/30 paper:bg-purple-500/15",
    uncommon: "bg-blue-500/10 text-blue-600 border-blue-500/30 paper:bg-blue-500/15",
    common: "bg-muted text-muted-foreground border-border",
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
  const iconColorClass = externalColor
    ? `${categoryIconColors[externalColor] ?? "text-muted-foreground"} paper:text-[color:var(--color-primary)]`
    : "text-muted-foreground paper:text-[color:var(--color-primary)]";
  const Chevron = expanded ? Icons.ChevronDown : Icons.ChevronRight;
  const SparkleIcon = Icons.Sparkles;

  const showBody = !collapsible || expanded;
  const titleRowClass = clsx(
    "flex items-center gap-2",
    collapsible && "cursor-pointer select-none",
  );

  return (
    <div
      className={clsx(
        "border border-border rounded-md p-2.5 border-l-2 space-y-1.5 bg-card/60",
        "paper:rounded-lg paper:bg-card paper:p-3 paper:space-y-2",
        rarityColors[rarity],
      )}
    >
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
          <Chevron className="w-3 h-3 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
        {CategoryIcon && <CategoryIcon className={clsx("w-3.5 h-3.5 shrink-0", iconColorClass)} />}
        <span className="text-xs font-medium flex-1 truncate text-foreground paper:font-serif paper:italic paper:font-normal paper:text-[13px]">
          {title}
        </span>
        {isNew && (
          <span
            className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[9px] font-semibold tracking-wider uppercase text-purple-600 dark:text-purple-300 bg-purple-500/10 border border-purple-500/30 rounded-sm paper:rounded-full paper:font-mono"
            aria-label="new"
          >
            <SparkleIcon className="w-2.5 h-2.5" />
            NEW
          </span>
        )}
        <span
          className={clsx(
            "inline-flex items-center px-1.5 py-0.5 text-[10px] border rounded-sm",
            "paper:rounded-full paper:font-mono paper:tracking-[0.06em] paper:uppercase paper:px-2",
            rarityBadgeColors[rarity],
          )}
        >
          {category}
        </span>
      </div>
      {showBody && content && (
        <p className="text-[11px] text-muted-foreground leading-relaxed paper:font-serif paper:text-[12.5px] paper:leading-[1.6] paper:text-foreground/80">
          {content}
        </p>
      )}
      {showBody && tags && tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {tags.map((tag) => (
            <span
              key={tag}
              className="text-[9px] px-1.5 py-0.5 bg-muted text-muted-foreground rounded-sm paper:rounded-full paper:border paper:border-border paper:bg-transparent paper:font-mono paper:tracking-[0.04em] paper:px-2"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
};

const StatBar: ComponentRenderer = ({ element }) => {
  const resolve = useI18nResolver();
  const label = resolve(element.props?.label);
  const value = element.props?.value as number ?? 0;
  const max = element.props?.max as number ?? 100;
  const pct = Math.min(100, Math.max(0, (value / max) * 100));

  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-muted-foreground paper:paper-eyebrow paper:font-mono paper:tracking-[0.12em]">{label}</span>
        <span className="font-mono text-foreground paper:text-muted-foreground">{value}/{max}</span>
      </div>
      <div className="h-1.5 bg-muted rounded-full overflow-hidden paper:h-1 paper:bg-[color:var(--color-border)]">
        <div
          className="h-full bg-blue-500 rounded-full transition-all paper:bg-[color:var(--color-primary)]"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
};

const Progress: ComponentRenderer = ({ element }) => {
  const resolve = useI18nResolver();
  const value = element.props?.value as number ?? 0;
  const max = element.props?.max as number ?? 100;
  const label = resolve(element.props?.label);
  const pct = Math.min(100, Math.max(0, (value / max) * 100));

  return (
    <div className="space-y-1">
      {label && <span className="text-xs text-muted-foreground paper:paper-eyebrow paper:font-mono paper:tracking-[0.12em]">{label}</span>}
      <div className="h-2 bg-muted rounded-full overflow-hidden paper:h-1 paper:bg-[color:var(--color-border)]">
        <div
          className="h-full bg-emerald-500 rounded-full transition-all paper:bg-[color:var(--color-primary)]"
          style={{ width: `${pct}%` }}
        />
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
  const resolve = useI18nResolver();
  const title = resolve(element.props?.title);
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
        className="flex w-full items-center gap-1.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors paper:paper-eyebrow paper:font-mono paper:font-normal paper:tracking-[0.12em]"
      >
        <Chevron className={clsx("w-3 h-3 transition-transform shrink-0", open && "rotate-90")} />
        {SectionIcon && <SectionIcon className="w-3 h-3 shrink-0 paper:hidden" />}
        <span className="truncate text-left">{title}</span>
      </button>
      {open && (
        <div className="border-l border-border pl-3 ml-1.5 space-y-1 pb-2 pt-0.5 paper:border-dashed">
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
    return <span className="text-muted-foreground/60 italic text-[10px]">—</span>;
  }
  if (typeof value === "string") {
    return <span className="text-[11px] text-foreground/90 whitespace-pre-wrap">{value}</span>;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return <span className="text-[11px] font-mono text-blue-600 dark:text-blue-400 paper:text-[color:var(--color-primary)]">{String(value)}</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span className="text-muted-foreground/60 italic text-[10px]">[ ]</span>;
    }
    const allPrimitive = value.every(
      (v) => v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean",
    );
    if (allPrimitive) {
      return (
        <div className="flex flex-wrap gap-1">
          {value.map((v, i) => (
            <span
              key={i}
              className="text-[9px] px-1.5 py-0.5 bg-muted text-muted-foreground rounded-sm paper:rounded-full paper:border paper:border-border paper:bg-transparent paper:font-mono"
            >
              {String(v)}
            </span>
          ))}
        </div>
      );
    }
    return (
      <div className="space-y-1.5">
        {value.map((item, i) => (
          <div key={i} className="border-l border-border pl-2 paper:border-dashed">
            {renderJsonValue(item, depth + 1)}
          </div>
        ))}
      </div>
    );
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      return <span className="text-muted-foreground/60 italic text-[10px]">{"{ }"}</span>;
    }
    return (
      <div className={clsx("space-y-0.5", depth > 0 && "mt-0.5")}>
        {entries.map(([k, v]) => {
          const isNested = v !== null && typeof v === "object";
          return (
            <div key={k} className="text-[11px] leading-snug">
              <span className="text-muted-foreground font-medium paper:font-mono paper:tracking-[0.04em]">{k}</span>
              <span className="text-muted-foreground/60">: </span>
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
  const resolve = useI18nResolver();
  const label = resolve(element.props?.label);
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
        "font-medium rounded-md transition-all text-left relative paper:rounded-md",
        size === "compact" ? "px-2.5 py-1 text-[11px]" : "px-3 py-1.5 text-xs paper:px-3.5 paper:py-1.5",
        // Base variant styles — applied only when NOT selected.
        !isSelected && variant === "primary" && "bg-blue-600 text-white hover:bg-blue-700 paper:bg-[color:var(--color-primary)] paper:text-[color:var(--color-primary-foreground)] paper:hover:opacity-90",
        !isSelected && variant === "default" && "bg-muted text-foreground hover:bg-accent paper:bg-card paper:border paper:border-border paper:hover:border-[color:var(--color-primary)]/40",
        !isSelected && variant === "ghost" && "bg-card/60 border border-border hover:bg-muted paper:bg-transparent paper:border-dashed paper:border-border paper:hover:border-[color:var(--color-primary)]/60",
        !isSelected && variant === "danger" && "bg-red-600 text-white hover:bg-red-700 paper:bg-red-600/90",
        // Selected state — distinct from every variant so the pick is obvious.
        isSelected && "bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-200 border border-blue-500 dark:border-blue-400 ring-2 ring-blue-500/40 dark:ring-blue-400/30 shadow-sm " +
          "paper:bg-[color:var(--color-primary)]/10 paper:text-[color:var(--color-primary)] paper:border-[color:var(--color-primary)] paper:ring-[color:var(--color-primary)]/30",
      )}
    >
      {isSelected && (
        <span
          aria-hidden="true"
          className="inline-block mr-1.5 text-blue-600 dark:text-blue-300 paper:text-[color:var(--color-primary)]"
        >
          ✓
        </span>
      )}
      {label}
    </button>
  );
};

const inputBase =
  "w-full bg-background border border-border px-2.5 py-1.5 text-xs rounded-md outline-none focus:ring-1 focus:ring-ring text-foreground placeholder:text-muted-foreground " +
  "paper:bg-card paper:font-sans paper:text-[12.5px] paper:focus:ring-[color:var(--color-primary)]/40";

const Input: ComponentRenderer = ({ element, bindings }) => {
  const resolve = useI18nResolver();
  const placeholder = resolve(element.props?.placeholder);
  const label = resolve(element.props?.label);
  const value = element.props?.value as string ?? "";
  const { set } = useStateStore();
  const bindPath = bindings?.value;

  return (
    <div className="space-y-1">
      {label && (
        <label className="text-xs text-muted-foreground paper:paper-eyebrow paper:font-mono paper:tracking-[0.12em]">
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

const SearchInput: ComponentRenderer = ({ element, bindings }) => {
  const resolve = useI18nResolver();
  const placeholder = resolve(element.props?.placeholder);
  const value = element.props?.value as string ?? "";
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

const Select: ComponentRenderer = ({ element, bindings }) => {
  const resolve = useI18nResolver();
  const label = resolve(element.props?.label);
  const value = element.props?.value as string ?? "";
  const options = element.props?.options as Array<{ value: string; label: unknown }> ?? [];
  const { set } = useStateStore();
  const bindPath = bindings?.value;

  return (
    <div className="space-y-1">
      {label && (
        <label className="text-xs text-muted-foreground paper:paper-eyebrow paper:font-mono paper:tracking-[0.12em]">
          {label}
        </label>
      )}
      <select
        value={value}
        onChange={(e) => bindPath && set(bindPath, e.target.value)}
        className={inputBase}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>{resolve(opt.label)}</option>
        ))}
      </select>
    </div>
  );
};

const Switch: ComponentRenderer = ({ element, bindings }) => {
  const resolve = useI18nResolver();
  const label = resolve(element.props?.label);
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
          checked
            ? "bg-blue-600 paper:bg-[color:var(--color-primary)]"
            : "bg-muted paper:bg-[color:var(--color-border)]",
        )}
      >
        <div className={clsx(
          "w-3.5 h-3.5 bg-background rounded-full absolute top-0.5 transition-transform shadow-sm",
          checked ? "translate-x-4" : "translate-x-0.5",
        )} />
      </div>
      <span className="text-xs text-foreground">{label}</span>
    </label>
  );
};

const FilterBar: ComponentRenderer = ({ element, bindings }) => {
  const resolve = useI18nResolver();
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
              "paper:rounded-full paper:font-mono paper:tracking-[0.08em] paper:px-2.5",
              active
                ? "bg-primary text-primary-foreground border-primary paper:bg-[color:var(--color-primary)] paper:text-[color:var(--color-primary-foreground)] paper:border-[color:var(--color-primary)]"
                : "bg-transparent text-muted-foreground border-border hover:border-foreground/40 paper:hover:border-[color:var(--color-primary)]/60 paper:hover:text-foreground",
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
  const resolve = useI18nResolver();
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
    <div role="tablist" className="flex flex-wrap gap-1 border-b border-border pb-1 paper:border-dashed paper:gap-2 paper:pb-0">
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
              // Paper tabs adopt Variant A's crumb-bar underline style: mono
              // uppercase label, 1.5px accent underline on the active tab.
              "paper:font-mono paper:text-[10px] paper:uppercase paper:tracking-[0.08em] paper:px-2.5 paper:py-1 paper:border-b-[1.5px]",
              active
                ? clsx(
                    "font-semibold text-foreground",
                    accent || "border-foreground",
                    "paper:font-normal paper:border-[color:var(--color-primary)] paper:text-foreground",
                  )
                : "border-transparent text-muted-foreground hover:text-foreground paper:hover:text-foreground",
            )}
          >
            {TabIcon && <TabIcon className="w-3 h-3 paper:hidden" />}
            {resolve(tab.label)}
            {count !== undefined && (
              <span className="text-[10px] text-muted-foreground/70 ml-0.5 paper:font-mono">({count})</span>
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
  const { t } = useTranslation();
  const resolve = useI18nResolver();
  const items = (element.props?.items as unknown[]) ?? [];
  const searchPlaceholder = resolve(element.props?.searchPlaceholder);
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
  const emptyMessage = resolve(element.props?.emptyMessage);
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
    ? t("common.noMatch")
    : t("common.noData");

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
            className="w-full bg-background border border-border pl-7 pr-3 py-1.5 text-xs rounded-md outline-none focus:ring-1 focus:ring-ring text-foreground placeholder:text-muted-foreground paper:bg-card paper:font-sans paper:text-[12.5px] paper:focus:ring-[color:var(--color-primary)]/40"
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
          <p className="text-xs text-muted-foreground italic text-center py-4 paper:font-serif paper:text-[13px]">
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
  const resolve = useI18nResolver();
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
  const raw = resolve(footer);
  const rendered = raw.replace(/\{\{\s*count\s*\}\}/g, String(totalCount));
  if (!rendered) return null;
  return (
    <p className="text-[11px] text-muted-foreground text-center pt-1 border-t border-border/60 paper:border-dashed paper:font-mono paper:tracking-[0.04em]">
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
    <div className="space-y-3 paper:space-y-5 paper-narrative paper:max-w-[42rem]">
      {paragraphs.map((p, i) => (
        <p
          key={i}
          className="text-sm text-foreground leading-relaxed paper:text-[18px] paper:leading-[1.78] paper:font-light"
        >
          {p.split(/(\*\*[^*]+\*\*)/).map((segment, j) =>
            segment.startsWith("**") && segment.endsWith("**")
              ? <strong key={j} className="font-semibold paper:font-medium">{segment.slice(2, -2)}</strong>
              : segment
          )}
        </p>
      ))}
    </div>
  );
};

/** PlayerMessage — renders player's input message (right-aligned bubble).
 *  In Paper, follows Variant A's editorial "YOU" convention: left-aligned
 *  with a 2px accent bar and a mono uppercase eyebrow. */
const PlayerMessage: ComponentRenderer = ({ element }) => {
  const content = element.props?.content as string ?? "";
  return (
    <div className="flex justify-end paper:justify-start">
      <div className="max-w-[80%] bg-blue-600 text-white px-4 py-2.5 rounded-2xl rounded-br-sm text-sm leading-relaxed paper:max-w-none paper:w-full paper:bg-transparent paper:text-foreground paper:px-0 paper:py-0 paper:rounded-none paper:border-l-2 paper:border-l-[color:var(--color-primary)] paper:pl-3.5">
        <span className="hidden paper:block paper-eyebrow mb-1 text-[color:var(--color-primary)]">
          You
        </span>
        <span className="paper:font-sans paper:text-[14px] paper:leading-[1.6]">{content}</span>
      </div>
    </div>
  );
};

/** Alert — renders notifications (info, success, warning, error). */
const Alert: ComponentRenderer = ({ element }) => {
  const resolve = useI18nResolver();
  const level = element.props?.level as string ?? "info";
  const title = resolve(element.props?.title);
  const message = resolve(element.props?.message);

  // Paper tints use the warm-paper card surface with a colored left bar,
  // which keeps semantic signal without breaking the editorial palette.
  const colors: Record<string, string> = {
    success: "border-emerald-500/30 bg-emerald-50 dark:bg-emerald-900/10 text-emerald-700 dark:text-emerald-400 paper:bg-card paper:text-foreground paper:border-l-2 paper:border-l-emerald-500 paper:border-border",
    warning: "border-amber-500/30 bg-amber-50 dark:bg-amber-900/10 text-amber-700 dark:text-amber-400 paper:bg-card paper:text-foreground paper:border-l-2 paper:border-l-amber-500 paper:border-border",
    error: "border-red-500/30 bg-red-50 dark:bg-red-900/10 text-red-700 dark:text-red-400 paper:bg-card paper:text-foreground paper:border-l-2 paper:border-l-red-500 paper:border-border",
    info: "border-blue-500/30 bg-blue-50 dark:bg-blue-900/10 text-blue-700 dark:text-blue-400 paper:bg-card paper:text-foreground paper:border-l-2 paper:border-l-[color:var(--color-primary)] paper:border-border",
  };

  return (
    <div className={clsx("border rounded-lg px-4 py-2.5 text-sm paper:rounded-md", colors[level])}>
      {title && <div className="font-medium text-xs paper:paper-eyebrow paper:font-mono paper:tracking-[0.12em] paper:mb-1">{title}</div>}
      {message && <div className="text-xs mt-0.5 opacity-80 paper:opacity-100 paper:font-serif paper:text-[13px] paper:leading-[1.55]">{message}</div>}
    </div>
  );
};

/** FormField — a single form field (text input or select). */
const FormField: ComponentRenderer = ({ element, bindings }) => {
  const { t } = useTranslation();
  const resolve = useI18nResolver();
  const fieldType = element.props?.fieldType as string ?? "text";
  const label = resolve(element.props?.label);
  const placeholder = resolve(element.props?.placeholder);
  const required = element.props?.required as boolean;
  const options = element.props?.options as Array<{ value: string; label: string }> | undefined;
  const value = element.props?.value as string ?? "";
  const disabled = element.props?.disabled as boolean;
  const { set } = useStateStore();
  const bindPath = bindings?.value;

  const fieldCls =
    "w-full bg-background border border-border px-3 py-1.5 text-sm rounded-md outline-none focus:ring-1 focus:ring-ring disabled:opacity-50 text-foreground placeholder:text-muted-foreground " +
    "paper:bg-card paper:font-sans paper:text-[13px] paper:focus:ring-[color:var(--color-primary)]/40 paper:py-2";

  return (
    <div className="space-y-1 paper:space-y-1.5">
      <label className="text-xs text-muted-foreground paper:paper-eyebrow paper:font-mono paper:tracking-[0.12em]">
        {label}
        {required && <span className="text-destructive ml-0.5">*</span>}
      </label>
      {fieldType === "select" && options ? (
        <select
          value={value}
          onChange={(e) => bindPath && set(bindPath, e.target.value)}
          disabled={disabled}
          className={fieldCls}
        >
          <option value="">{placeholder ?? t("form.selectPrefix", { label })}</option>
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
          className={fieldCls}
        />
      )}
    </div>
  );
};

/** SubmitButton — styled form submit button with disabled state. */
const SubmitButton: ComponentRenderer = ({ element, emit }) => {
  const resolve = useI18nResolver();
  const label = resolve(element.props?.label);
  const disabled = element.props?.disabled as boolean;

  return (
    <button
      type="button"
      onClick={() => emit("click")}
      disabled={disabled}
      className={clsx(
        "w-full py-2.5 text-sm font-medium rounded-md transition-colors",
        "paper:py-3 paper:text-[13px] paper:tracking-[0.04em]",
        disabled
          ? "bg-muted text-muted-foreground cursor-not-allowed"
          : "bg-blue-600 text-white hover:bg-blue-700 paper:bg-[color:var(--color-primary)] paper:text-[color:var(--color-primary-foreground)] paper:hover:opacity-90",
      )}
    >
      {label}
    </button>
  );
};

/** Source — subtle source attribution label. */
const Source: ComponentRenderer = ({ element }) => {
  const label = element.props?.label as string ?? "";
  return (
    <span className="text-[9px] text-muted-foreground/70 block mt-1 paper:font-mono paper:tracking-[0.04em]">
      {label}
    </span>
  );
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
  const { t } = useTranslation();
  const { state } = useSession();
  const dims = state.world?.dimensions;
  if (!dims) {
    return (
      <p className="text-xs text-muted-foreground italic">
        {t("world.dimensionsEmpty")}
      </p>
    );
  }
  return <WorldDimensionsPanel dimensions={dims} />;
};

// ── Form Components ──────────────────────────────────────────────

const Form: ComponentRenderer = ({ children }) => {
  return (
    <div className="border border-border rounded-lg overflow-hidden bg-card/60 paper:bg-card paper:rounded-lg">
      <div className="p-4 space-y-3 paper:p-5 paper:space-y-4">{children}</div>
    </div>
  );
};

/** FormHeader — form title bar. */
const FormHeader: ComponentRenderer = ({ element }) => {
  const resolve = useI18nResolver();
  const title = resolve(element.props?.title);
  return (
    <div className="bg-muted/60 px-4 py-2 -mx-4 -mt-4 mb-3 border-b border-border paper:bg-transparent paper:border-dashed paper:px-5 paper:-mx-5 paper:-mt-5 paper:py-3">
      <span className="text-xs font-medium text-foreground paper:font-serif paper:italic paper:font-normal paper:text-[15px] paper:text-foreground">
        {title}
      </span>
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
