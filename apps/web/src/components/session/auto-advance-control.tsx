import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSession } from "@/stores/session-store.js";

/** Host controls remain reachable even when a plugin or immersive stage fills the scene. */
export function AutoAdvanceControl() {
  const { state, abortActiveTurn } = useSession();
  const { t } = useTranslation();
  const [error, setError] = useState<string>();
  const advance = state.advance;
  const active = advance && advance.phase !== "stopped";
  return (
    <div
      data-testid="auto-advance-control"
      className="relative z-10 flex shrink-0 flex-wrap items-center gap-2 border-b border-(--rule-color) bg-(--surface-page) px-4 py-2 text-xs"
    >
      {active && (
        <>
          <span role="status">
            {t("session.autoAdvanceProgress", {
              round: advance.round,
              limit: advance.limit,
            })}
          </span>
          <button
            type="button"
            onClick={() =>
              void abortActiveTurn().catch((cause: unknown) =>
                setError(
                  cause instanceof Error ? cause.message : String(cause),
                ),
              )
            }
          >
            {t("session.autoAdvanceStop")}
          </button>
        </>
      )}
      {error && <span role="alert">{error}</span>}
    </div>
  );
}
