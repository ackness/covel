import { useTranslation } from "react-i18next";
import {
  PlayerItems,
  PlayerStatusMeters,
  usePlayerStatus,
} from "./player-status.js";
import {
  readoutLines,
  SummaryLines,
  useSessionSummary,
} from "./session-summary.js";

/**
 * The strip under the context panel's labelled tabs: who the player is, their
 * gauges and carried items, and whatever plugins put in the session summary.
 * It subscribes on its own so a new summary does not re-render the panel —
 * that would remount the plugin panels below it.
 */
export function PanelStatus({ sessionId }: { readonly sessionId: string }) {
  const { t } = useTranslation();
  const status = usePlayerStatus();
  const summary = useSessionSummary(sessionId);
  if (!status && summary.length === 0) return null;
  return (
    // No display utility on the strip itself: the scene layout hides it from
    // the components layer while its HUD shows the same content.
    <div
      className="ui-panel-status shrink-0 border-b border-(--rule-color) px-4 py-3"
      aria-label={t("session.playerStatus")}
      role="group"
    >
      <div className="flex flex-col gap-2.5">
        <div className="flex items-baseline justify-between gap-3">
          <span className="ui-title ui-panel-status-name min-w-0 truncate text-sm font-semibold">
            {status?.name}
          </span>
          {/* A heading only some themes set, e.g. a notebook's title. */}
          <span className="ui-panel-status-title">{t("session.notebook")}</span>
        </div>
        {status && <PlayerStatusMeters status={status} layout="columns" />}
        {status && <PlayerItems items={status.items} max={6} />}
        <SummaryLines lines={[...readoutLines(status), ...summary]} />
      </div>
    </div>
  );
}
