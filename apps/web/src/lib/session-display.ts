import type { TFunction } from "i18next";

const STATUS_KEYS = {
  active: "session.statusActive",
  paused: "session.statusPaused",
  ended: "session.statusEnded",
} as const;

export function sessionStatusLabel(
  t: TFunction,
  status: keyof typeof STATUS_KEYS,
): string {
  return t(STATUS_KEYS[status]);
}

export function sessionTurnLabel(t: TFunction, count: number): string {
  return t("session.turnCount", { count });
}

export function formatSessionDate(value: string, locale: string): string {
  return new Date(value).toLocaleString(locale);
}
