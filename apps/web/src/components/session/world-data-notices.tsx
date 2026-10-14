import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { WorldDataImportNotice } from "@covel/shared";

/**
 * Tells the player which of the world's data this game is without, such as
 * what a plugin still waiting for approval receives. The data arrives when
 * that plugin is turned on, and the list then shows what is still missing.
 */
export function WorldDataNotices({
  notices,
}: {
  readonly notices: readonly WorldDataImportNotice[];
}) {
  const { t } = useTranslation();
  // Hidden until a new import reports again.
  const [hidden, setHidden] = useState<readonly WorldDataImportNotice[]>();
  if (notices.length === 0 || notices === hidden) return null;
  return (
    <div
      role="status"
      data-testid="world-data-notices"
      className="relative z-10 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs"
    >
      <div className="flex items-start justify-between gap-2">
        <p>{t("session.worldDataNotices.title")}</p>
        <button
          type="button"
          className="shrink-0 underline"
          onClick={() => setHidden(notices)}
        >
          {t("session.worldDataNotices.hide")}
        </button>
      </div>
      <ul className="mt-1 list-disc pl-4">
        {notices.map((notice, index) => (
          <li key={`${notice.sourceId ?? ""}:${index}`}>
            {notice.sourceId ? `${notice.sourceId}: ` : ""}
            {notice.message}
          </li>
        ))}
      </ul>
      <p className="mt-1 text-muted-foreground">
        {t("session.worldDataNotices.hint")}
      </p>
    </div>
  );
}
