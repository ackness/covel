import type { TFunction } from "i18next";
import type { ConfirmRequest } from "@/lib/confirm-channel.js";
import { formatSessionDate, sessionTurnLabel } from "@/lib/session-display.js";
import type {
  MediaLibraryItem,
  MediaLibrarySession,
} from "@/services/api/media.js";

/** Chosen media ID → its size, kept across pages and filters. */
export type MediaSelection = ReadonlyMap<string, number>;

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function formatBytes(bytes: number, locale: string): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  const number = new Intl.NumberFormat(locale, {
    maximumFractionDigits: digits,
  }).format(value);
  return `${number} ${BYTE_UNITS[unit]}`;
}

/**
 * Only media that no session uses can be chosen for a batch. An asset that a
 * session uses, or whose use could not be determined, is deleted one at a
 * time, after a confirmation that says what will lose it.
 */
export function isBatchSelectable(item: MediaLibraryItem): boolean {
  return item.usage === "unused";
}

export function toggleSelection(
  selection: MediaSelection,
  item: MediaLibraryItem,
): MediaSelection {
  const next = new Map(selection);
  if (next.has(item.id)) next.delete(item.id);
  else if (isBatchSelectable(item)) next.set(item.id, item.size);
  return next;
}

/** Choose every selectable item of a page, or clear them when all are chosen. */
export function togglePageSelection(
  selection: MediaSelection,
  items: readonly MediaLibraryItem[],
): MediaSelection {
  const selectable = items.filter(isBatchSelectable);
  const next = new Map(selection);
  if (selectable.every((item) => next.has(item.id))) {
    for (const item of selectable) next.delete(item.id);
  } else {
    for (const item of selectable) next.set(item.id, item.size);
  }
  return next;
}

export function withoutIds(
  selection: MediaSelection,
  ids: readonly string[],
): MediaSelection {
  const next = new Map(selection);
  for (const id of ids) next.delete(id);
  return next;
}

export function selectionBytes(selection: MediaSelection): number {
  let bytes = 0;
  for (const size of selection.values()) bytes += size;
  return bytes;
}

/** "World name · Turn 12 · date": a session has no title of its own. */
export function sessionLabel(
  t: TFunction,
  session: MediaLibrarySession,
  worldName: string | undefined,
  locale: string,
): string {
  return [
    worldName ?? session.worldId ?? session.id.slice(0, 8),
    sessionTurnLabel(t, session.completedPlayerTurns),
    formatSessionDate(session.createdAt, locale),
  ].join(" · ");
}

/** Confirmation for deleting a batch of media that no session uses. */
export function unusedDeleteConfirmation(
  t: TFunction,
  count: number,
  bytes: number,
  locale: string,
): ConfirmRequest {
  return {
    title: t("mediaLibrary.confirmUnusedTitle"),
    message: t("mediaLibrary.confirmUnusedMessage", {
      count,
      size: formatBytes(bytes, locale),
    }),
    confirmLabel: t("mediaLibrary.confirmDelete"),
    cancelLabel: t("common.cancel"),
    destructive: true,
  };
}

/**
 * Confirmation for deleting one item. When something still uses it, the text
 * names every session that will lose it.
 */
export function itemDeleteConfirmation(
  t: TFunction,
  item: MediaLibraryItem,
  sessionLabels: readonly string[],
  locale: string,
): ConfirmRequest {
  const size = formatBytes(item.size, locale);
  const base = {
    confirmLabel: t("mediaLibrary.confirmDelete"),
    cancelLabel: t("common.cancel"),
    destructive: true,
  };
  if (item.usage === "unused") {
    return {
      ...base,
      title: t("mediaLibrary.confirmUnusedTitle"),
      message: t("mediaLibrary.confirmUnusedMessage", { count: 1, size }),
    };
  }
  if (item.usage === "used") {
    return {
      ...base,
      title: t("mediaLibrary.confirmInUseTitle"),
      message: t("mediaLibrary.confirmInUseMessage", {
        size,
        sessions: sessionLabels.map((label) => `• ${label}`).join("\n"),
      }),
    };
  }
  return {
    ...base,
    title: t("mediaLibrary.confirmInUseTitle"),
    message: t(
      item.usage === "held"
        ? "mediaLibrary.confirmHeldMessage"
        : "mediaLibrary.confirmUnknownMessage",
      { size },
    ),
  };
}
