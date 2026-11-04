import type { TFunction } from "i18next";
import { requestConfirm } from "@/lib/confirm-channel.js";
import { sessionSaveLabel } from "@/lib/session-display.js";
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
    title: t("session.deleteConfirmTitle", "Delete save"),
    message: t(
      "session.deleteConfirmDesc",
      "This permanently deletes the save and all its data (messages, game state and so on). It cannot be undone.",
    ),
    subject: sessionSaveLabel(t, locale, session, worldName),
    confirmLabel: t("common.delete", "Delete"),
    cancelLabel: t("common.cancel", "Cancel"),
    destructive: true,
  });
}
