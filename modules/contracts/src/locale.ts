import { z } from "zod";

export const SupportedLocaleSchema = z.enum(["zh-CN", "en"]);

export type SupportedLocale = z.infer<typeof SupportedLocaleSchema>;

export const DEFAULT_LOCALE: SupportedLocale = "zh-CN";

export function normalizeLocale(input: unknown): SupportedLocale {
  if (typeof input !== "string") {
    return DEFAULT_LOCALE;
  }

  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return DEFAULT_LOCALE;
  }

  const normalized = trimmed.toLowerCase();
  if (normalized === "en" || normalized.startsWith("en-")) {
    return "en";
  }

  if (normalized === "zh" || normalized === "zh-cn" || normalized.startsWith("zh-")) {
    return "zh-CN";
  }

  return DEFAULT_LOCALE;
}

export function resolveLocaleFromHeader(input: unknown): SupportedLocale {
  if (typeof input !== "string") {
    return DEFAULT_LOCALE;
  }

  const candidates = input
    .split(",")
    .map((entry) => entry.split(";")[0]?.trim())
    .filter((entry): entry is string => Boolean(entry));

  for (const candidate of candidates) {
    const locale = normalizeLocale(candidate);
    if (candidate && locale === "en" && candidate.toLowerCase().startsWith("en")) {
      return locale;
    }
    if (candidate && locale === "zh-CN" && candidate.toLowerCase().startsWith("zh")) {
      return locale;
    }
  }

  return DEFAULT_LOCALE;
}
