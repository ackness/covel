/**
 * core-renderers — public re-export barrel.
 *
 * Layout + display renderers live here (Stack, Row, Grid, Separator,
 * Text, Badge, Icon, TagList, StatBar, Progress, Accordion, Section,
 * renderJsonValue, JsonView).
 *
 * Card-family renderers (Card, CardList, EntryCard) are in card-renderers.tsx.
 * Shared color/icon lookup maps are in catalog-constants.ts.
 * Collapse state logic is in use-collapsible.ts.
 *
 * All symbols remain importable from this path so existing consumers
 * continue to work without change.
 */

import { useState, type ReactNode } from "react";
import type { ComponentRenderer } from "@json-render/react";
import { clsx } from "clsx";
import * as Icons from "lucide-react";
import { resolveIcon, toTextArray, useI18nResolver } from "./helpers.js";
import {
  gapClasses,
  alignClasses,
  justifyClasses,
  iconSizeClasses,
  badgeColorMap,
} from "./catalog-constants.js";

// ── Layout Components ────────────────────────────────────────────

export const Stack: ComponentRenderer = ({ element, children }) => {
  const gap = (element.props?.gap as string) ?? "md";
  const gapClass = gapClasses[gap] ?? "gap-3";
  return <div className={clsx("flex flex-col", gapClass)}>{children}</div>;
};

export const Row: ComponentRenderer = ({ element, children }) => {
  const gap = (element.props?.gap as string) ?? "sm";
  const align = (element.props?.align as string) ?? "center";
  const justify = element.props?.justify as string | undefined;
  const gapClass = gapClasses[gap] ?? "gap-2";
  const alignClass = alignClasses[align] ?? "items-center";
  const justifyClass = justify ? (justifyClasses[justify] ?? "") : "";
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
  return (
    <span
      className={clsx(
        "ui-chip inline-flex items-center px-1.5 py-0.5 text-[10px] border",
        badgeColorMap[color ?? ""] ??
          "bg-muted text-muted-foreground border-border",
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
  const sizeClass = iconSizeClasses[size] ?? "w-4 h-4";
  return <LucideIcon className={sizeClass} />;
};

export const TagList: ComponentRenderer = ({ element }) => {
  const tags = toTextArray(element.props?.tags);
  if (tags.length === 0) return null;
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

/** Deeper than any real plugin payload; a guard, not a display preference. */
const MAX_JSON_RENDER_DEPTH = 32;

/**
 * Render any JSON value with shape-aware styling.
 * Primitives inline, arrays of primitives as tag list, arrays of objects
 * as vertical list, nested objects as key: value pairs.
 */
export function renderJsonValue(value: unknown, depth: number): ReactNode {
  // Plugin data is arbitrarily deep and unvalidated; without a cap a pathological
  // (or cyclic-looking) structure recurses until the stack blows, and a RangeError
  // during render takes out the whole subtree.
  if (depth > MAX_JSON_RENDER_DEPTH) {
    return <span className="text-muted-foreground/60 text-[10px]">…</span>;
  }
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

// ── Re-exports from sub-modules ────────────────────────────────────
export { Card, CardList, EntryCard } from "./card-renderers.js";
