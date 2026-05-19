import { Children, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ComponentRenderer } from "@json-render/react";
import { clsx } from "clsx";
import * as Icons from "lucide-react";
import { resolveIcon, useI18nResolver } from "./helpers.js";

// ── Layout Components ────────────────────────────────────────────

export const Stack: ComponentRenderer = ({ element, children }) => {
  const gap = (element.props?.gap as string) ?? "md";
  const gapClass =
    { xs: "gap-1", sm: "gap-2", md: "gap-3", lg: "gap-4" }[gap] ?? "gap-3";
  return <div className={clsx("flex flex-col", gapClass)}>{children}</div>;
};

export const Row: ComponentRenderer = ({ element, children }) => {
  const gap = (element.props?.gap as string) ?? "sm";
  const align = (element.props?.align as string) ?? "center";
  const justify = element.props?.justify as string | undefined;
  const gapClass =
    { xs: "gap-1", sm: "gap-2", md: "gap-3", lg: "gap-4" }[gap] ?? "gap-2";
  const alignClass =
    { start: "items-start", center: "items-center", end: "items-end" }[align] ??
    "items-center";
  const justifyClass = justify
    ? ({
        start: "justify-start",
        center: "justify-center",
        end: "justify-end",
        between: "justify-between",
        around: "justify-around",
      }[justify] ?? "")
    : "";
  return (
    <div className={clsx("flex flex-row", gapClass, alignClass, justifyClass)}>
      {children}
    </div>
  );
};

export const Grid: ComponentRenderer = ({ element, children }) => {
  const cols = (element.props?.cols as number) ?? 2;
  return (
    <div
      className={clsx("grid gap-3", {
        "grid-cols-1": cols === 1,
        "grid-cols-2": cols === 2,
        "grid-cols-3": cols === 3,
        "grid-cols-4": cols === 4,
      })}
    >
      {children}
    </div>
  );
};

export const Separator: ComponentRenderer = () => (
  <hr className="ui-rule border-t border-border my-2" />
);

// ── Display Components ───────────────────────────────────────────

export const Text: ComponentRenderer = ({ element, children }) => {
  const resolve = useI18nResolver();
  const content =
    resolve(element.props?.content) ||
    (typeof children === "string" ? children : "");
  const variant = element.props?.variant as string;
  const weight = element.props?.weight as string;
  const size = element.props?.size as string;
  const align = element.props?.align as string;

  return (
    <p
      className={clsx(
        "leading-relaxed text-foreground",
        variant === "muted" && "text-muted-foreground",
        weight === "bold" && "font-semibold",
        size === "xs" && "text-[10px]",
        size === "sm" && "text-xs",
        size === "lg" && "text-lg ui-entry-title",
        align === "center" && "text-center",
      )}
    >
      {content || children}
    </p>
  );
};

export const Badge: ComponentRenderer = ({ element }) => {
  const resolve = useI18nResolver();
  const label = resolve(element.props?.label);
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
    <span
      className={clsx(
        "ui-chip inline-flex items-center px-1.5 py-0.5 text-[10px] border",
        colorMap[color ?? ""] ?? "bg-muted text-muted-foreground border-border",
      )}
    >
      {label}
    </span>
  );
};

export const Icon: ComponentRenderer = ({ element }) => {
  const name = element.props?.name as string;
  const size = (element.props?.size as string) ?? "sm";
  const LucideIcon = resolveIcon(name);
  if (!LucideIcon) return null;
  const sizeClass =
    { xs: "w-3 h-3", sm: "w-4 h-4", md: "w-5 h-5", lg: "w-6 h-6" }[size] ??
    "w-4 h-4";
  return <LucideIcon className={sizeClass} />;
};

export const TagList: ComponentRenderer = ({ element }) => {
  const tags = element.props?.tags as string[];
  if (!tags || tags.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {tags.map((tag) => (
        <span
          key={tag}
          className="ui-chip text-[9px] px-1.5 py-0.5 bg-muted text-muted-foreground"
        >
          {tag}
        </span>
      ))}
    </div>
  );
};

// ── Data Components ──────────────────────────────────────────────

export const Card: ComponentRenderer = ({ element, children }) => {
  const variant = element.props?.variant as string;
  const collapsible = (element.props?.collapsible as boolean) ?? false;
  const defaultExpanded = (element.props?.defaultExpanded as boolean) ?? false;
  const [expanded, setExpanded] = useState(defaultExpanded);

  let body: ReactNode = children;
  if (collapsible) {
    const items = Children.toArray(children);
    const head = items[0];
    const rest = items.slice(1);
    const Chevron = expanded ? Icons.ChevronDown : Icons.ChevronRight;
    body = (
      <>
        <div
          className="flex items-center gap-2 cursor-pointer select-none"
          onClick={() => setExpanded((v) => !v)}
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setExpanded((v) => !v);
            }
          }}
        >
          <Chevron
            className="w-3 h-3 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <div className="flex-1 min-w-0">{head}</div>
        </div>
        {expanded && rest}
      </>
    );
  }

  // Default Card now reads as a band — marker bar on the left, no enclosure.
  // Variants:
  //   glow    → highlighted band with primary marker
  //   subtle  → quiet section with just internal padding & breathable spacing
  //   frame   → opt-in enclosed frame for cases that genuinely need walls
  if (variant === "frame") {
    return <div className="ui-frame p-4 space-y-2.5">{body}</div>;
  }
  if (variant === "subtle") {
    // Used heavily by plugins for choice grids — needs comfortable padding
    // and inter-child spacing or the content reads as a wall of text.
    return (
      <div className="px-3 py-3 space-y-2 border-l-2 border-[var(--rule-color)] hover:border-[var(--accent-primary)] transition-colors">
        {body}
      </div>
    );
  }
  return (
    <div
      className="ui-band space-y-2"
      data-tone={variant === "glow" ? undefined : "muted"}
    >
      {body}
    </div>
  );
};

export const CardList: ComponentRenderer = ({ children }) => {
  return <div className="space-y-2">{children}</div>;
};

export const EntryCard: ComponentRenderer = ({ element }) => {
  const { t } = useTranslation();
  const resolve = useI18nResolver();
  const title = resolve(element.props?.title);
  const category = (element.props?.category as string) ?? "";
  const content = resolve(element.props?.content);
  const tags = element.props?.tags as string[] | undefined;
  const rarity = (element.props?.rarity as string) ?? "common";
  // Optional plugin-supplied per-category icon + color (e.g. from a
  // plugin's categoryMeta payload). When provided they override the
  // built-in fallback map below; when missing the card still renders
  // sensibly via the fallback so pre-enrichment entries keep working.
  const externalIcon = element.props?.icon as string | undefined;
  const externalColor = element.props?.color as string | undefined;
  // Generic feature flags — any plugin can set these via itemLiteralProps
  // or itemPropMap. collapsible toggles a chevron that hides body/tags;
  // isNew renders a purple "NEW" sparkle next to the title.
  const collapsible = (element.props?.collapsible as boolean) ?? false;
  const defaultExpanded = (element.props?.defaultExpanded as boolean) ?? true;
  const isNew = (element.props?.isNew as boolean) ?? false;

  const [expanded, setExpanded] = useState(defaultExpanded);

  const categoryIcons: Record<string, string> = {
    monster: "skull",
    item: "gem",
    location: "map-pin",
    lore: "scroll-text",
    character: "users",
    skill: "sparkles",
  };
  const rarityTone: Record<string, string> = {
    legendary: "warning",
    rare: "info",
    uncommon: "info",
    common: "muted",
  };
  const rarityMarkerColor: Record<string, string> = {
    legendary: "var(--accent-warning)",
    rare: "var(--accent-secondary)",
    uncommon: "var(--accent-secondary)",
    common: "var(--color-border)",
  };
  const rarityBadgeColors: Record<string, string> = {
    legendary: "bg-amber-500/10 text-amber-600 border-amber-500/30",
    rare: "bg-purple-500/10 text-purple-600 border-purple-500/30",
    uncommon: "bg-blue-500/10 text-blue-600 border-blue-500/30",
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

  const CategoryIcon = resolveIcon(
    externalIcon ?? categoryIcons[category] ?? "book-open",
  );
  const iconColorClass = externalColor
    ? `${categoryIconColors[externalColor] ?? "text-primary"}`
    : "text-primary";
  const Chevron = expanded ? Icons.ChevronDown : Icons.ChevronRight;
  const SparkleIcon = Icons.Sparkles;

  const showBody = !collapsible || expanded;
  const titleRowClass = clsx(
    "flex items-center gap-2",
    collapsible && "cursor-pointer select-none",
  );

  return (
    <div
      className="ui-band space-y-2"
      data-tone={rarityTone[rarity] ?? "muted"}
      style={{ ["--tw-band-marker" as string]: rarityMarkerColor[rarity] }}
    >
      <div
        className={titleRowClass}
        onClick={collapsible ? () => setExpanded((v) => !v) : undefined}
        role={collapsible ? "button" : undefined}
        tabIndex={collapsible ? 0 : undefined}
        aria-expanded={collapsible ? expanded : undefined}
        onKeyDown={
          collapsible
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setExpanded((v) => !v);
                }
              }
            : undefined
        }
      >
        {collapsible && (
          <Chevron
            className="w-3 h-3 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        )}
        {CategoryIcon && (
          <CategoryIcon
            className={clsx("w-3.5 h-3.5 shrink-0", iconColorClass)}
          />
        )}
        <span className="ui-entry-title text-[13px] font-medium flex-1 truncate text-foreground">
          {title}
        </span>
        {isNew && (
          <span
            className="ui-chip inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[9px] font-semibold tracking-wider uppercase text-purple-600 dark:text-purple-300 bg-purple-500/10 border border-purple-500/30"
            aria-label={t("common.new", "new")}
          >
            <SparkleIcon className="w-2.5 h-2.5" />
            {t("common.newUpper", "NEW")}
          </span>
        )}
        <span
          className={clsx(
            "ui-chip inline-flex items-center px-1.5 py-0.5 text-[10px] border",
            rarityBadgeColors[rarity],
          )}
        >
          {category}
        </span>
      </div>
      {showBody && content && (
        <p className="text-[12.5px] text-muted-foreground leading-[1.6]">
          {content}
        </p>
      )}
      {showBody && tags && tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {tags.map((tag) => (
            <span
              key={tag}
              className="ui-chip text-[9px] px-1.5 py-0.5 bg-muted text-muted-foreground"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
};

export const StatBar: ComponentRenderer = ({ element }) => {
  const resolve = useI18nResolver();
  const label = resolve(element.props?.label);
  const value = (element.props?.value as number) ?? 0;
  const max = (element.props?.max as number) ?? 100;
  const pct = Math.min(100, Math.max(0, (value / max) * 100));

  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="ui-eyebrow text-muted-foreground">{label}</span>
        <span className="font-mono text-muted-foreground">
          {value}/{max}
        </span>
      </div>
      <div className="ui-meter-track h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className="ui-meter-fill h-full bg-primary rounded-full transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
};

export const Progress: ComponentRenderer = ({ element }) => {
  const resolve = useI18nResolver();
  const value = (element.props?.value as number) ?? 0;
  const max = (element.props?.max as number) ?? 100;
  const label = resolve(element.props?.label);
  const pct = Math.min(100, Math.max(0, (value / max) * 100));

  return (
    <div className="space-y-1">
      {label && (
        <span className="ui-eyebrow text-xs text-muted-foreground">
          {label}
        </span>
      )}
      <div className="ui-meter-track h-2 bg-muted rounded-full overflow-hidden">
        <div
          className="ui-meter-fill h-full bg-emerald-500 rounded-full transition-all"
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
export const Accordion: ComponentRenderer = ({ children }) => (
  <div className="space-y-0.5">{children}</div>
);

/**
 * Section — collapsible header + content block.
 * Self-contained open state; receives title/icon via props, body via children.
 */
export const Section: ComponentRenderer = ({ element, children }) => {
  const resolve = useI18nResolver();
  const title = resolve(element.props?.title);
  const iconName = element.props?.icon as string | undefined;
  const defaultOpen = (element.props?.defaultOpen as boolean) ?? false;
  const [open, setOpen] = useState(defaultOpen);
  const SectionIcon = resolveIcon(iconName);
  const Chevron = Icons.ChevronRight;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="ui-eyebrow flex w-full items-center gap-1.5 py-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
      >
        <Chevron
          className={clsx(
            "w-3 h-3 transition-transform shrink-0",
            open && "rotate-90",
          )}
        />
        {SectionIcon && <SectionIcon className="w-3 h-3 shrink-0" />}
        <span className="truncate text-left">{title}</span>
      </button>
      {open && (
        <div className="ui-outline-rail border-l border-border pl-3 ml-1.5 space-y-1 pb-2 pt-0.5">
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
export function renderJsonValue(value: unknown, depth: number): ReactNode {
  if (value === null || value === undefined) {
    return (
      <span className="text-muted-foreground/60 italic text-[10px]">—</span>
    );
  }
  if (typeof value === "string") {
    return (
      <span className="text-[11px] text-foreground/90 whitespace-pre-wrap">
        {value}
      </span>
    );
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return (
      <span className="text-[11px] font-mono text-primary">
        {String(value)}
      </span>
    );
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return (
        <span className="text-muted-foreground/60 italic text-[10px]">[ ]</span>
      );
    }
    const allPrimitive = value.every(
      (v) =>
        v === null ||
        typeof v === "string" ||
        typeof v === "number" ||
        typeof v === "boolean",
    );
    if (allPrimitive) {
      return (
        <div className="flex flex-wrap gap-1">
          {value.map((v, i) => (
            <span
              key={i}
              className="ui-chip text-[9px] px-1.5 py-0.5 bg-muted text-muted-foreground"
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
          <div key={i} className="ui-outline-rail border-l border-border pl-2">
            {renderJsonValue(item, depth + 1)}
          </div>
        ))}
      </div>
    );
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      return (
        <span className="text-muted-foreground/60 italic text-[10px]">
          {"{ }"}
        </span>
      );
    }
    return (
      <div className={clsx("space-y-0.5", depth > 0 && "mt-0.5")}>
        {entries.map(([k, v]) => {
          const isNested = v !== null && typeof v === "object";
          return (
            <div key={k} className="text-[11px] leading-snug">
              <span className="font-mono text-muted-foreground">{k}</span>
              <span className="text-muted-foreground/60">: </span>
              {isNested ? (
                <div className="pl-2 mt-0.5">
                  {renderJsonValue(v, depth + 1)}
                </div>
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
export const JsonView: ComponentRenderer = ({ element }) => {
  const value = element.props?.value;
  return <div className="text-[11px]">{renderJsonValue(value, 0)}</div>;
};
