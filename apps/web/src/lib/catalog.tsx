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
import { useCharacterAttributeSchema } from "@/stores/plugin-data-store.js";
import { WorldDimensionsPanel } from "@/components/session/world-dimensions-panel.js";
import { Media as MediaComponent } from "@/components/Media.js";
import type { MediaRef } from "@covel/shared";
import { isMediaRef } from "@/lib/media-ref-utils.js";

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
  <hr className="ui-rule border-t border-border my-2" />
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
      weight === "bold" && "font-semibold",
      size === "xs" && "text-[10px]",
      size === "sm" && "text-xs",
      size === "lg" && "text-lg ui-entry-title",
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
      "ui-chip inline-flex items-center px-1.5 py-0.5 text-[10px] border",
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
          className="ui-chip text-[9px] px-1.5 py-0.5 bg-muted text-muted-foreground"
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
      "ui-card-surface border border-border rounded-[var(--radius-card)] p-3 bg-card/60",
      variant === "glow" && "shadow-lg shadow-amber-500/20 border-amber-500/50",
      variant === "subtle" && "bg-muted/40 border-dashed",
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
  const rarityColors: Record<string, string> = {
    legendary: "border-l-amber-500",
    rare: "border-l-purple-500/70",
    uncommon: "border-l-blue-500/60",
    common: "border-l-border",
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

  const CategoryIcon = resolveIcon(externalIcon ?? categoryIcons[category] ?? "book-open");
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
      className={clsx(
        "ui-card-surface border border-border rounded-[var(--radius-card)] p-3 border-l-2 space-y-2 bg-card",
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
        <span className="ui-entry-title text-[13px] font-medium flex-1 truncate text-foreground">
          {title}
        </span>
        {isNew && (
          <span
            className="ui-chip inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[9px] font-semibold tracking-wider uppercase text-purple-600 dark:text-purple-300 bg-purple-500/10 border border-purple-500/30"
            aria-label="new"
          >
            <SparkleIcon className="w-2.5 h-2.5" />
            NEW
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

const StatBar: ComponentRenderer = ({ element }) => {
  const resolve = useI18nResolver();
  const label = resolve(element.props?.label);
  const value = element.props?.value as number ?? 0;
  const max = element.props?.max as number ?? 100;
  const pct = Math.min(100, Math.max(0, (value / max) * 100));

  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="ui-eyebrow text-muted-foreground">{label}</span>
        <span className="font-mono text-muted-foreground">{value}/{max}</span>
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

const Progress: ComponentRenderer = ({ element }) => {
  const resolve = useI18nResolver();
  const value = element.props?.value as number ?? 0;
  const max = element.props?.max as number ?? 100;
  const label = resolve(element.props?.label);
  const pct = Math.min(100, Math.max(0, (value / max) * 100));

  return (
    <div className="space-y-1">
      {label && <span className="ui-eyebrow text-xs text-muted-foreground">{label}</span>}
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
        className="ui-eyebrow flex w-full items-center gap-1.5 py-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
      >
        <Chevron className={clsx("w-3 h-3 transition-transform shrink-0", open && "rotate-90")} />
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
function renderJsonValue(value: unknown, depth: number): ReactNode {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground/60 italic text-[10px]">—</span>;
  }
  if (typeof value === "string") {
    return <span className="text-[11px] text-foreground/90 whitespace-pre-wrap">{value}</span>;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return <span className="text-[11px] font-mono text-primary">{String(value)}</span>;
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
      return <span className="text-muted-foreground/60 italic text-[10px]">{"{ }"}</span>;
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

// ── CharacterFieldsView ─────────────────────────────────────────
//
// Schema-aware renderer for a character's `fields` object.
//
// The world-data-provider plugin (currently core-world-init) publishes an
// attribute schema under `(*, 'schema', 'character-attributes')`. When that
// schema is present we pick the matching definition for each field id and
// render:
//   - `number` with min+max → labelled progress bar
//   - `number`              → right-aligned mono value
//   - `enum`                → badge
//   - `array`               → chip list
//   - `boolean`             → ✓ / —
//   - `object`              → nested indented child rows driven by subSchema
//   - `map`                 → key/value rows (free-form keys, typed values)
//   - `string` / fallback   → plain value
// Fields not covered by the schema fall through to `renderJsonValue` so
// legacy data (or fields the LLM invented off-schema) still shows up
// instead of vanishing.
//
// Labels come from `attr.name` (set by schema-gen at session locale). The
// five category headings are framework-level and use `character.categories.*`.

type AttributeFieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'array'
  | 'object'
  | 'map';
type CatId = 'stats' | 'bio' | 'abilities' | 'equipment' | 'social';

interface AttrDefLite {
  readonly id: string;
  readonly name?: string;
  readonly type: AttributeFieldType;
  readonly min?: number;
  readonly max?: number;
  readonly options?: readonly string[];
  readonly category: CatId;
  readonly defaultValue?: unknown;
  readonly subSchema?: readonly AttrDefLite[];
  readonly valueType?: 'string' | 'number' | 'boolean';
}

const CATEGORY_ORDER: readonly CatId[] = ["bio", "stats", "abilities", "equipment", "social"];

const CATEGORY_META: Record<CatId, { icon: string; tone: string }> = {
  stats:     { icon: "heart",     tone: "text-red-500 dark:text-red-400" },
  bio:       { icon: "book-user", tone: "text-blue-500 dark:text-blue-400" },
  abilities: { icon: "swords",    tone: "text-amber-500 dark:text-amber-400" },
  equipment: { icon: "backpack",  tone: "text-green-500 dark:text-green-400" },
  social:    { icon: "users",     tone: "text-purple-500 dark:text-purple-400" },
};

function AttributeProgressBar({ label, value, min, max }: {
  label: string;
  value: number;
  min: number;
  max: number;
}) {
  const range = max - min;
  const pct = range > 0 ? Math.max(0, Math.min(100, ((value - min) / range) * 100)) : 0;
  const tone = pct > 60 ? "bg-emerald-500/80" : pct > 30 ? "bg-amber-500/80" : "bg-rose-500/80";
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between text-[10px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono text-foreground/70">{value}/{max}</span>
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className={clsx("h-full transition-all duration-500", tone)}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function AttributeRow({ attr, value }: { attr: AttrDefLite; value: unknown }) {
  const label = attr.name?.trim() || attr.id;

  if (attr.type === "number" && typeof value === "number" && attr.max !== undefined) {
    return <AttributeProgressBar label={label} value={value} min={attr.min ?? 0} max={attr.max} />;
  }

  if (attr.type === "number" && typeof value === "number") {
    return (
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono text-foreground/90">{value}</span>
      </div>
    );
  }

  if (attr.type === "enum" && typeof value === "string") {
    return (
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="ui-chip text-[10px] px-1.5 py-0.5 bg-muted text-foreground/80 border border-border/60">
          {value}
        </span>
      </div>
    );
  }

  if (attr.type === "array" && Array.isArray(value)) {
    if (value.length === 0) {
      return (
        <div className="flex items-center justify-between gap-2 text-[11px]">
          <span className="text-muted-foreground">{label}</span>
          <span className="text-muted-foreground/60 italic text-[10px]">—</span>
        </div>
      );
    }
    return (
      <div className="space-y-1 text-[11px]">
        <span className="text-muted-foreground">{label}</span>
        <div className="flex flex-wrap gap-1">
          {value.map((item, i) => (
            <span
              key={`${attr.id}-${i}`}
              className="ui-chip text-[10px] px-1.5 py-0.5 bg-muted text-foreground/80 border border-border/60"
            >
              {typeof item === "object" && item !== null ? JSON.stringify(item) : String(item)}
            </span>
          ))}
        </div>
      </div>
    );
  }

  if (attr.type === "boolean") {
    return (
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="text-muted-foreground">{label}</span>
        <span className={value ? "text-emerald-500" : "text-muted-foreground/60"}>
          {value ? "✓" : "—"}
        </span>
      </div>
    );
  }

  // Object — indented block of child rows driven by subSchema. Extras not
  // declared in subSchema are rendered through renderJsonValue so they're
  // visible but clearly secondary.
  if (attr.type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    const nested = value as Record<string, unknown>;
    const subSchema = attr.subSchema ?? [];
    const subById = new Map<string, AttrDefLite>();
    for (const s of subSchema) subById.set(s.id, s);
    const extras = Object.keys(nested).filter((k) => !subById.has(k));
    return (
      <div className="space-y-1 text-[11px]">
        <span className="text-muted-foreground">{label}</span>
        <div className="pl-3 border-l border-border/40 space-y-1">
          {subSchema.map((sub) => {
            const sv = nested[sub.id] ?? sub.defaultValue;
            if (sv === undefined) return null;
            return <AttributeRow key={sub.id} attr={sub} value={sv} />;
          })}
          {extras.map((k) => (
            <div key={k} className="text-[11px] leading-snug">
              <span className="font-mono text-muted-foreground">{k}</span>
              <span className="text-muted-foreground/60">: </span>
              {renderJsonValue(nested[k], 1)}
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Map — free-key dictionary, render as label + indented key/value rows.
  // Values are already primitives per schema (`valueType`), so inline them.
  if (attr.type === "map" && value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      return (
        <div className="flex items-center justify-between gap-2 text-[11px]">
          <span className="text-muted-foreground">{label}</span>
          <span className="text-muted-foreground/60 italic text-[10px]">—</span>
        </div>
      );
    }
    return (
      <div className="space-y-1 text-[11px]">
        <span className="text-muted-foreground">{label}</span>
        <div className="pl-3 border-l border-border/40 space-y-0.5">
          {entries.map(([k, v]) => (
            <div key={k} className="flex items-start justify-between gap-2">
              <span className="font-mono text-muted-foreground shrink-0">{k}</span>
              <span className="text-foreground/90 text-right max-w-[60%] whitespace-pre-wrap">
                {v === null || v === undefined
                  ? "—"
                  : typeof v === "object" ? JSON.stringify(v) : String(v)}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // String / fallback
  return (
    <div className="flex items-start justify-between gap-2 text-[11px]">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="text-foreground/90 text-right max-w-[60%] whitespace-pre-wrap">
        {value === undefined || value === null || value === ""
          ? "—"
          : typeof value === "object" ? JSON.stringify(value) : String(value)}
      </span>
    </div>
  );
}

const CharacterFieldsView: ComponentRenderer = ({ element }) => {
  const { t } = useTranslation();
  const raw = element.props?.value;
  const schema = useCharacterAttributeSchema() as
    | { attributes?: readonly AttrDefLite[] }
    | null;

  const fields = (raw && typeof raw === "object" && !Array.isArray(raw))
    ? raw as Record<string, unknown>
    : {};

  const attrs = schema?.attributes ?? [];
  const attrById = new Map<string, AttrDefLite>(attrs.map((a) => [a.id, a]));

  // Group schema attributes by category, keeping the schema's ordering
  // inside each category. An attribute is included when either the
  // character has a value for it, or the schema ships a defaultValue.
  const groups = new Map<CatId, AttrDefLite[]>();
  for (const attr of attrs) {
    const hasValue = Object.prototype.hasOwnProperty.call(fields, attr.id);
    if (!hasValue && attr.defaultValue === undefined) continue;
    const cat = (CATEGORY_ORDER.includes(attr.category) ? attr.category : "bio") as CatId;
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat)!.push(attr);
  }

  // Fields the LLM wrote that the schema doesn't know about. Show them
  // under a "custom" bucket at the bottom so nothing silently vanishes.
  const unknownKeys = Object.keys(fields).filter((k) => !attrById.has(k));

  const hasAnything = groups.size > 0 || unknownKeys.length > 0;
  if (!hasAnything) {
    return (
      <div className="text-[11px]">
        {renderJsonValue(raw, 0)}
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      {CATEGORY_ORDER.filter((cat) => groups.has(cat)).map((cat) => {
        const meta = CATEGORY_META[cat];
        const Icon = resolveIcon(meta.icon);
        return (
          <div key={cat} className="space-y-1">
            <div className={clsx("flex items-center gap-1.5", meta.tone)}>
              {Icon && <Icon className="h-3 w-3" />}
              <span className="text-[9px] font-semibold uppercase tracking-widest">
                {t(`character.categories.${cat}`, cat)}
              </span>
            </div>
            <div className="space-y-1 pl-0.5">
              {groups.get(cat)!.map((attr) => {
                const value = fields[attr.id] ?? attr.defaultValue;
                return <AttributeRow key={attr.id} attr={attr} value={value} />;
              })}
            </div>
          </div>
        );
      })}

      {unknownKeys.length > 0 && (
        <div className="space-y-1 pt-1 border-t border-dashed border-border/40">
          <div className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">
            {t("character.categories.custom", "Other")}
          </div>
          <div className="space-y-0.5">
            {unknownKeys.map((k) => (
              <div key={k} className="text-[11px] leading-snug">
                <span className="font-mono text-muted-foreground">{k}</span>
                <span className="text-muted-foreground/60">: </span>
                {renderJsonValue(fields[k], 1)}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
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

  // ── In-flight feedback for plugin-rpc dispatch ─────────────────────
  //
  // PluginPanel writes `/_invoking/<key>` whenever an `invokeRuntime` /
  // `invokePluginAction` click is mid-flight. The button's click binding
  // tells us which key it would set, so we can show a spinner exactly on
  // the button that fired the action — no risk of dimming the whole panel.
  const invokingMap = (getState("/_invoking") as Record<string, boolean> | undefined) ?? {};
  const isPending = useMemo(() => {
    const click = element.on?.click;
    if (!click) return false;
    const bindings = Array.isArray(click) ? click : [click];
    for (const binding of bindings) {
      const resolved = resolveActionParams(
        binding.params as Record<string, unknown> | undefined,
        getState,
      );
      if (binding.action === "invokeRuntime" && typeof resolved.runtimeId === "string") {
        if (invokingMap[`runtime:${resolved.runtimeId}`]) return true;
      }
      if (binding.action === "invokePluginAction" && typeof resolved.action === "string") {
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
        size === "compact" ? "px-2.5 py-1 text-[11px]" : "px-3.5 py-1.5 text-xs",
        !isSelected && variant === "primary" && "bg-primary text-primary-foreground hover:opacity-90",
        !isSelected && variant === "default" && "bg-card text-foreground border border-border hover:border-primary/40",
        !isSelected && variant === "ghost" && "bg-card/60 border border-border border-dashed hover:border-primary/60",
        !isSelected && variant === "danger" && "bg-red-600 text-white hover:bg-red-700",
        isSelected && "bg-primary/10 text-primary border border-primary ring-2 ring-primary/30 shadow-sm",
        isPending && "opacity-70 cursor-progress",
      )}
    >
      {isPending && <Loader aria-hidden="true" className="w-3 h-3 animate-spin" />}
      {!isPending && isSelected && (
        <span
          aria-hidden="true"
          className="inline-block text-primary"
        >
          ✓
        </span>
      )}
      <span>{label}</span>
    </button>
  );
};

const inputBase =
  "ui-input-shell w-full bg-background border border-border px-2.5 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring text-foreground placeholder:text-muted-foreground";

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
            ? "bg-primary"
            : "bg-muted",
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
    <div role="tablist" className="ui-rule flex flex-wrap gap-2 border-b border-border pb-1">
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
              "ui-eyebrow px-2.5 py-1 border-b-[1.5px]",
              active
                ? clsx(
                    "text-foreground",
                    accent || "border-foreground",
                  )
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {TabIcon && <TabIcon className="w-3 h-3" />}
            {resolve(tab.label)}
            {count !== undefined && (
              <span className="text-[10px] text-muted-foreground/70 ml-0.5 font-mono">({count})</span>
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
          on={() => ({ emit: () => {}, shouldPreventDefault: false, bound: false })}
        />
      )}
      <div className="flex flex-col gap-2">
        {filtered.length === 0 && (
          <p className="ui-empty-copy text-xs italic text-center py-4 mx-auto">
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
    <p className="ui-rule text-[11px] text-muted-foreground text-center pt-1 border-t border-border/60 font-mono tracking-[0.04em]">
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
    <div className="ui-narrative space-y-5 max-w-[var(--story-max-width)]">
      {paragraphs.map((p, i) => (
        <p
          key={i}
          className="text-sm text-foreground leading-relaxed"
        >
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

/** PlayerMessage — renders player's input message (right-aligned bubble).
 *  In Paper, follows Variant A's editorial "YOU" convention: left-aligned
 *  with a 2px accent bar and a mono uppercase eyebrow. */
const PlayerMessage: ComponentRenderer = ({ element }) => {
  const content = element.props?.content as string ?? "";
  return (
    <div className="ui-player-message-row flex justify-end">
      <div className="ui-message-player max-w-[80%] px-4 py-2.5 text-sm leading-relaxed">
        <span className="ui-eyebrow mb-1 block text-primary">
          You
        </span>
        <span className="text-[14px] leading-[1.6]">{content}</span>
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

  const colors: Record<string, string> = {
    success: "border-emerald-500/30 bg-emerald-50 dark:bg-emerald-900/10 text-emerald-700 dark:text-emerald-400",
    warning: "border-amber-500/30 bg-amber-50 dark:bg-amber-900/10 text-amber-700 dark:text-amber-400",
    error: "border-red-500/30 bg-red-50 dark:bg-red-900/10 text-red-700 dark:text-red-400",
    info: "border-blue-500/30 bg-blue-50 dark:bg-blue-900/10 text-blue-700 dark:text-blue-400",
  };

  return (
    <div className={clsx("ui-card-surface border rounded-[var(--radius-card)] px-4 py-2.5 text-sm", colors[level])}>
      {title && <div className="ui-eyebrow font-medium text-xs mb-1">{title}</div>}
      {message && <div className="text-[13px] mt-0.5 opacity-90 leading-[1.55]">{message}</div>}
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
    "ui-input-shell w-full bg-background border border-border px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring disabled:opacity-50 text-foreground placeholder:text-muted-foreground";

  return (
    <div className="space-y-1.5">
      <label className="ui-eyebrow text-xs text-muted-foreground">
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
        "w-full py-3 text-sm font-medium rounded-[var(--radius-control)] transition-colors tracking-[0.04em]",
        disabled
          ? "bg-muted text-muted-foreground cursor-not-allowed"
          : "bg-primary text-primary-foreground hover:opacity-90",
      )}
    >
      {label}
    </button>
  );
};

/**
 * Image — renders a remote or inlined image.
 *
 * Props:
 *   src:      URL or `data:` URI (falls back to base64 + mimeType when URL absent).
 *   base64:   raw base64 (no prefix); combined with `mimeType` into a data URI.
 *   mimeType: e.g. "image/png"; defaults to "image/png".
 *   alt:      accessibility fallback.
 *   aspectRatio: "1/1" | "16/9" | "3/4" | string — CSS aspect-ratio.
 *   rounded:  "none" | "sm" | "md" | "lg" — border-radius scale.
 *   fit:      "cover" | "contain" — object-fit behaviour (default "cover").
 *
 * When both `src` and `base64` are empty, renders a muted placeholder so the
 * layout does not collapse. Pure-text fallback avoids any broken-image glyph.
 */
/**
 * Pick the appropriate radius utility class. Kept local so both the
 * legacy base64/url path and the new MediaRef path share the same scale.
 */
function imageRadiusCls(rounded: string): string {
  if (rounded === "none") return "rounded-none";
  if (rounded === "sm") return "rounded-sm";
  if (rounded === "lg") return "rounded-lg";
  return "rounded-[var(--radius-card)]";
}

/**
 * Lightweight hook to grab the active sessionId so MediaRef-resolution
 * can include it in signed-token requests. Falls back to "" — the
 * resolver's data-URI sentinel handles missing-session paths gracefully.
 *
 * Soft-binds to SessionContext: when the catalog is rendered outside a
 * SessionProvider (debug fixtures, isolated tests, snapshot panels) we
 * return "" instead of throwing. Plugin specs that depend on a session
 * must pass `props.sessionId` explicitly in those contexts.
 */
function useActiveSessionId(): string {
  try {
    const { state } = useSession();
    return state.session?.id ?? "";
  } catch {
    return "";
  }
}

/**
 * Read either `props.src` or `props.ref` for a MediaRef. Plugin specs
 * use `ref` for new code (matches the SPEC); some early adopters set
 * `src` to a MediaRef object directly. Both shapes route through the
 * same `<Media>` component.
 */
function extractMediaRef(props: Record<string, unknown> | undefined): MediaRef | null {
  if (!props) return null;
  const candidates: unknown[] = [props.ref, props.src];
  for (const c of candidates) {
    if (isMediaRef(c)) return c;
  }
  return null;
}

const ImageComponent: ComponentRenderer = ({ element }) => {
  const sessionId = useActiveSessionId();
  const props = element.props ?? {};
  const alt = (props.alt as string | undefined) ?? "";
  const aspectRatio = (props.aspectRatio as string | undefined) ?? "1/1";
  const rounded = (props.rounded as string | undefined) ?? "md";
  const fit = (props.fit as "cover" | "contain" | undefined) ?? "cover";

  // ── Path 1: MediaRef (new) — delegate to <Media> for cache + token resolve.
  const ref = extractMediaRef(props);
  if (ref) {
    const overrideSession =
      typeof props.sessionId === "string" && props.sessionId.length > 0
        ? (props.sessionId as string)
        : sessionId;
    return (
      <MediaComponent
        src={ref}
        sessionId={overrideSession}
        alt={alt}
        aspectRatio={aspectRatio}
        rounded={rounded as "none" | "sm" | "md" | "lg"}
        fit={fit}
        as="image"
      />
    );
  }

  // ── Path 2: legacy base64 / url — preserved verbatim for back-compat.
  const rawSrc = typeof props.src === "string" ? (props.src as string) : undefined;
  const base64 = props.base64 as string | undefined;
  const mimeType = (props.mimeType as string | undefined) ?? "image/png";
  const radiusCls = imageRadiusCls(rounded);

  const src =
    rawSrc && rawSrc.length > 0
      ? rawSrc
      : base64 && base64.length > 0
      ? `data:${mimeType};base64,${base64}`
      : null;

  if (!src) {
    return (
      <div
        className={clsx(
          "bg-muted border border-border flex items-center justify-center",
          radiusCls,
        )}
        style={{ aspectRatio }}
        aria-label={alt || "image placeholder"}
      >
        <span className="text-[10px] text-muted-foreground/70 font-mono">no image</span>
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      className={clsx(
        "w-full block",
        radiusCls,
        fit === "contain" ? "object-contain" : "object-cover",
      )}
      style={{ aspectRatio }}
    />
  );
};

/**
 * `Media` registry entry — generic renderer for SPEC §5.1 (g). Plugin
 * specs can use `{ "type": "Media", "props": { "ref": <MediaRef>, ... } }`
 * to render any modality (image / audio / video). Falls through to a
 * `<a download>` link for unknown MIME types so unfamiliar payloads
 * never break the layout.
 */
const MediaCatalogComponent: ComponentRenderer = ({ element }) => {
  const sessionId = useActiveSessionId();
  const props = element.props ?? {};
  const ref = extractMediaRef(props);
  const stringSrc = typeof props.src === "string" ? (props.src as string) : null;

  const overrideSession =
    typeof props.sessionId === "string" && props.sessionId.length > 0
      ? (props.sessionId as string)
      : sessionId;

  const alt = (props.alt as string | undefined) ?? "";
  const aspectRatio = (props.aspectRatio as string | undefined) ?? "1/1";
  const rounded = (props.rounded as "none" | "sm" | "md" | "lg" | undefined) ?? "md";
  const fit = (props.fit as "cover" | "contain" | undefined) ?? "cover";
  const as = (props.as as "image" | "audio" | "video" | "auto" | undefined) ?? "auto";

  if (!ref && !stringSrc) {
    return (
      <div
        className={clsx(
          "bg-muted border border-border flex items-center justify-center",
          imageRadiusCls(rounded),
        )}
        style={{ aspectRatio }}
        aria-label={alt || "media placeholder"}
      >
        <span className="text-[10px] text-muted-foreground/70 font-mono">no media</span>
      </div>
    );
  }

  return (
    <MediaComponent
      src={ref ?? (stringSrc as string)}
      sessionId={overrideSession}
      alt={alt}
      aspectRatio={aspectRatio}
      rounded={rounded}
      fit={fit}
      as={as}
    />
  );
};

/** Source — subtle source attribution label. */
const Source: ComponentRenderer = ({ element }) => {
  const label = element.props?.label as string ?? "";
  return (
    <span className="text-[9px] text-muted-foreground/70 block mt-1 font-mono tracking-[0.04em]">
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
    <div className="ui-card-surface border border-border rounded-[var(--radius-card)] overflow-hidden bg-card">
      <div className="p-5 space-y-4">{children}</div>
    </div>
  );
};

/** FormHeader — form title bar. */
const FormHeader: ComponentRenderer = ({ element }) => {
  const resolve = useI18nResolver();
  const title = resolve(element.props?.title);
  return (
    <div className="ui-rule bg-muted/60 px-5 py-3 -mx-5 -mt-5 mb-3 border-b border-border">
      <span className="ui-entry-title text-[15px] font-medium text-foreground">
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
  Image: ImageComponent,
  Media: MediaCatalogComponent,
  // Data
  Card,
  CardList,
  EntryCard,
  StatBar,
  Progress,
  Accordion,
  Section,
  JsonView,
  CharacterFieldsView,
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
