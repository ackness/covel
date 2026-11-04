import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSession } from "@/stores/session-store.js";
import { emitToast } from "@/lib/toast-channel.js";
import { useNotice } from "@/lib/notice-center.js";

/**
 * Auto-advance shows as a status chip in the session header: "Advancing 2 / 5",
 * and clicking it stops. A failed stop is a toast.
 */
export function AutoAdvanceNotice({ sessionId }: { sessionId: string }): null {
  const { state, abortActiveTurn } = useSession();
  const { t } = useTranslation();
  const [stopping, setStopping] = useState(false);
  const advance = state.advance;
  const active = advance && advance.phase !== "stopped";
  useNotice(
    active
      ? {
          key: "auto-advance",
          kind: "status",
          tone: "info",
          scope: sessionId,
          title: t("session.autoAdvanceProgress", {
            round: advance.round,
            limit: advance.limit,
          }),
          actions: [
            {
              label: t("session.autoAdvanceStop"),
              disabled: stopping,
              onClick: () => {
                setStopping(true);
                void abortActiveTurn()
                  .catch((cause: unknown) =>
                    emitToast(
                      "error",
                      t("session.autoAdvanceStopFailed"),
                      cause instanceof Error ? cause.message : String(cause),
                    ),
                  )
                  .finally(() => setStopping(false));
              },
            },
          ],
        }
      : null,
  );
  return null;
}
