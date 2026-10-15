import i18n from "@/i18n/index.js";
import { resolveI18nText, type I18nText } from "@covel/shared";

/**
 * Resolve untrusted UI data through the shared I18nText contract.
 * Non-string record values are discarded before resolution so malformed
 * plugin data can never reach React as an object child.
 */
export function resolveDisplayText(value: unknown, locale?: string): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) return "";

  const localized = Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  ) as I18nText;
  return resolveI18nText(localized, locale ?? i18n.language) ?? "";
}

/**
 * Join names the way the interface language writes a list ("A、B和C",
 * "A, B, and C"). `or` lists alternatives the player picks one of.
 */
export function formatList(
  items: readonly string[],
  type: "and" | "or" = "and",
  locale: string = i18n.language,
): string {
  return new Intl.ListFormat(locale, {
    type: type === "or" ? "disjunction" : "conjunction",
  }).format(items);
}
