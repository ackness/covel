import type { WorldRecord } from "@/services/api.js";
import { localeLanguage } from "@covel/shared";

export type WorldLanguage = "en" | "zh";

/** Normalize the primary language subtag used by Covel's locale switcher. */
export function worldLanguage(
  locale: string | undefined,
): WorldLanguage | null {
  const language = localeLanguage(locale);
  return language === "en" || language === "zh" ? language : null;
}

/**
 * Put worlds authored for the active UI language first without hiding the
 * remaining catalog or changing order inside either group.
 */
export function prioritizeWorldsByLocale(
  worlds: readonly WorldRecord[],
  locale: string | undefined,
): WorldRecord[] {
  const preferredLanguage = worldLanguage(locale);
  if (!preferredLanguage) return [...worlds];

  const preferred: WorldRecord[] = [];
  const remaining: WorldRecord[] = [];
  for (const world of worlds) {
    (worldLanguage(world.locale) === preferredLanguage
      ? preferred
      : remaining
    ).push(world);
  }
  return [...preferred, ...remaining];
}

export function worldLanguageBadge(locale: string | undefined): string | null {
  const language = worldLanguage(locale);
  if (language === "en") return "EN";
  if (language === "zh") return "ZH";
  return null;
}
