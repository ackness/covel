import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import i18nInstance from "@/i18n";
import * as Icons from "lucide-react";

export interface FilterTab {
  value: string;
  label?: unknown;
  icon?: string;
  color?: string;
}

export function resolveIcon(name: string | undefined): Icons.LucideIcon | null {
  // The declared type is a lie at runtime: `name` comes straight out of a
  // plugin-authored spec, so anything can arrive here and `.split` would throw.
  if (typeof name !== "string" || !name) return null;
  // Convert kebab-case to PascalCase: "book-open" -> "BookOpen"
  const pascal = name
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
  return (
    ((Icons as Record<string, unknown>)[pascal] as
      Icons.LucideIcon | undefined) ?? null
  );
}

/**
 * Resolve an `I18nText`-shaped value (`string | Record<locale, string>`) to a
 * plain string, honoring the current i18n locale.
 *
 * Match order: exact locale (`zh-CN`) -> prefix match (`zh-CN` -> `zh`) ->
 * English fallbacks (`en-US`/`en`) -> any available value -> empty string.
 *
 * When no locale is passed, the current `i18next` language is read at call
 * time. Components that render `resolveI18n(...)` output should also call
 * `useI18nResolver()` to subscribe to language changes and re-render.
 */
export function resolveI18n(value: unknown, locale?: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    // A locale-keyed record from a plugin spec is not guaranteed to hold
    // strings. Returning a nested object here would reach React as a child and
    // throw ("Objects are not valid as a React child"), so every branch below
    // goes through `asString`.
    const obj = value as Record<string, unknown>;
    const asString = (v: unknown): string | undefined =>
      typeof v === "string" ? v : undefined;
    const lang = locale ?? i18nInstance.language ?? "";
    const exact = lang ? asString(obj[lang]) : undefined;
    if (exact) return exact;
    const prefix = lang.split("-")[0];
    if (prefix) {
      for (const k of Object.keys(obj)) {
        if (k !== prefix && !k.startsWith(`${prefix}-`)) continue;
        const match = asString(obj[k]);
        if (match) return match;
      }
    }
    return (
      asString(obj["en-US"]) ??
      asString(obj["en"]) ??
      Object.values(obj).find((v): v is string => typeof v === "string") ??
      ""
    );
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
  return useCallback(
    (value: unknown) => resolveI18n(value, i18n.language),
    [i18n.language],
  );
}

export function isRecordLike(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Spec-supplied list props are unvalidated — the server only checks the spec
 * envelope, so `tabs`/`options`/`items` can be any shape. Normalise before
 * `.map` instead of letting a TypeError unwind the render tree.
 */
export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Same idea for the option/tab lists whose entries are rendered with
 * `key={item.value}` — drop anything that isn't a record with a string `value`
 * so the renderer can't be handed a primitive or a nested object.
 */
export function asOptionArray(value: unknown): Record<string, unknown>[] {
  return asArray(value).filter(
    (item): item is Record<string, unknown> =>
      isRecordLike(item) && typeof item.value === "string",
  );
}

export function toTextArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      // Coerce primitives rather than dropping them: an LLM-written `tags: [3]`
      // used to render "3", and silently losing it is a worse regression than
      // the object-child crash this guard exists to prevent.
      if (typeof item === "string") return item.trim();
      if (typeof item === "number" || typeof item === "boolean")
        return String(item);
      return "";
    })
    .filter((item) => item.length > 0);
}

export function formatDateTime(value: string | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Resolve a slash- or dot-delimited path against an object/array.
 * Returns undefined for missing segments. Numeric segments index arrays.
 */
export function resolvePath(value: unknown, path: string): unknown {
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
export function valueToHaystack(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (Array.isArray(value)) return value.map(valueToHaystack).join(" ");
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>)
      .map(valueToHaystack)
      .join(" ");
  }
  return "";
}

/**
 * Filter an items array against a search query and an active tab value.
 * Exported in test-only form via __testables (see bottom of catalog.tsx) so the
 * filter logic can be unit-tested without driving React.
 */
export function filterItems(
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
