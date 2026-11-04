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

/** Label for resuming a session; one still in setup has no turn to name. */
export function sessionContinueLabel(t: TFunction, count: number): string {
  return count > 0 ? t("session.continueTurn", { count }) : t("session.resume");
}

export function formatSessionDate(value: string, locale: string): string {
  return new Date(value).toLocaleString(locale);
}

/**
 * How a save is named everywhere: its world, the turn it reached and when it
 * was started. A save has no title of its own and its id means nothing to a
 * player.
 */
export function sessionSaveLabel(
  t: TFunction,
  locale: string,
  session: { completedPlayerTurns: number; createdAt: string },
  worldName?: string,
): string {
  return [
    worldName,
    sessionTurnLabel(t, session.completedPlayerTurns),
    formatSessionDate(session.createdAt, locale),
  ]
    .filter(Boolean)
    .join(" · ");
}
