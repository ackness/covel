/**
 * Covel component catalog for json-render.
 *
 * These are the UI primitives available to plugin JSON specs.
 * Plugins can only use components registered here — the framework
 * controls the vocabulary, plugins compose from it.
 */

import type { ComponentRenderer } from "@json-render/react";
import { useStateStore } from "@json-render/react";
import { clsx } from "clsx";
import * as Icons from "lucide-react";

// ── Helpers ──────────────────────────────────────────────────────

function resolveIcon(name: string | undefined): Icons.LucideIcon | null {
  if (!name) return null;
  // Convert kebab-case to PascalCase: "book-open" → "BookOpen"
  const pascal = name
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
  return (Icons as Record<string, unknown>)[pascal] as Icons.LucideIcon | undefined ?? null;
}

function resolveI18n(value: unknown): string {
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
  const gapClass = { xs: "gap-1", sm: "gap-2", md: "gap-3", lg: "gap-4" }[gap] ?? "gap-2";
  const alignClass = { start: "items-start", center: "items-center", end: "items-end" }[align] ?? "items-center";
  return <div className={clsx("flex flex-row", gapClass, alignClass)}>{children}</div>;
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

  const CategoryIcon = resolveIcon(categoryIcons[category] ?? "book-open");

  return (
    <div className={clsx("border border-zinc-200 dark:border-zinc-700 rounded-md p-2.5 border-l-2 space-y-1.5", rarityColors[rarity])}>
      <div className="flex items-center gap-2">
        {CategoryIcon && <CategoryIcon className="w-3.5 h-3.5 shrink-0 text-zinc-500" />}
        <span className="text-xs font-medium flex-1 truncate">{title}</span>
        <span className={clsx("inline-flex items-center px-1.5 py-0.5 text-[10px] border rounded-sm", rarityBadgeColors[rarity])}>
          {category}
        </span>
      </div>
      {content && <p className="text-[11px] text-zinc-500 dark:text-zinc-400 leading-relaxed">{content}</p>}
      {tags && tags.length > 0 && (
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

// ── Interactive Components ───────────────────────────────────────

const Button: ComponentRenderer = ({ element, emit }) => {
  const label = resolveI18n(element.props?.label);
  const variant = element.props?.variant as string ?? "default";
  return (
    <button
      type="button"
      onClick={() => emit("click")}
      className={clsx(
        "px-3 py-1.5 text-xs font-medium rounded-md transition-colors",
        variant === "primary" && "bg-blue-600 text-white hover:bg-blue-700",
        variant === "default" && "bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700",
        variant === "danger" && "bg-red-600 text-white hover:bg-red-700",
      )}
    >
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
const FormField: ComponentRenderer = ({ element, bindings, emit }) => {
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
  // Interactive
  Button,
  Input,
  SearchInput,
  Select,
  Switch,
  FilterBar,
  // Form
  Form,
  FormHeader,
  FormField,
  SubmitButton,
  // Message (chat area)
  Prose,
  PlayerMessage,
  Alert,
};
