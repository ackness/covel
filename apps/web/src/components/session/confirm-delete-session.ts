import type { TFunction } from "i18next";
import { requestConfirm } from "@/lib/confirm-channel.js";
import { formatSessionDate, sessionTurnLabel } from "@/lib/session-display.js";
import type { SessionRecord } from "@/services/api.js";

/**
 * Ask before deleting a save. A save has no title of its own, so the prompt
 * names it the way the lists do: its world, the turn it reached and when it
 * was started.
 */
export function confirmDeleteSession(
  t: TFunction,
  locale: string,
  session: SessionRecord,
  worldName?: string,
): Promise<boolean> {
  return requestConfirm({
    title: t("session.deleteConfirmTitle", "Delete Session"),
    message: t(
      "session.deleteConfirmDesc",
      "This will permanently delete the session and all its data (messages, game state, etc.). This action cannot be undone.",
    ),
    subject: [
      worldName,
      sessionTurnLabel(t, session.completedPlayerTurns),
      formatSessionDate(session.createdAt, locale),
    ]
      .filter(Boolean)
      .join(" · "),
    confirmLabel: t("common.delete", "Delete"),
    cancelLabel: t("common.cancel", "Cancel"),
    destructive: true,
  });
}
