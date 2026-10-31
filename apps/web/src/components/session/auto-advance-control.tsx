import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_AUTO_ADVANCE_LIMIT,
  MAX_AUTO_ADVANCE_LIMIT,
} from "@covel/shared";
import { useSession } from "@/stores/session-store.js";

/** Host controls remain reachable even when a plugin or immersive stage fills the scene. */
export function AutoAdvanceControl() {
  const { state, setAutoAdvanceLimit, abortActiveTurn } = useSession();
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const advance = state.advance;
  const active = advance && advance.phase !== "stopped";
  const save = async (limit: number) => {
    setSaving(true);
    setError(undefined);
    try {
      await setAutoAdvanceLimit(limit);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div
      data-testid="auto-advance-control"
      className="relative z-10 flex shrink-0 flex-wrap items-center gap-2 border-b border-(--rule-color) bg-(--surface-page) px-4 py-2 text-xs"
    >
      <label className="flex items-center gap-2">
        {t("session.autoAdvanceLimit")}
        <select
          aria-label={t("session.autoAdvanceLimit")}
          value={state.session?.autoAdvanceLimit ?? DEFAULT_AUTO_ADVANCE_LIMIT}
          disabled={saving}
          onChange={(event) => void save(Number(event.target.value))}
        >
          {Array.from({ length: MAX_AUTO_ADVANCE_LIMIT + 1 }, (_, value) => (
            <option key={value} value={value}>
              {value === 0 ? t("session.autoAdvanceOff") : value}
            </option>
          ))}
        </select>
      </label>
      <span>{t("session.autoAdvanceNextInput")}</span>
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
