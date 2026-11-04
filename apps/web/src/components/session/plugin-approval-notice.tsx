import { useTranslation } from "react-i18next";
import type { SessionPlugin } from "@covel/shared";
import { resolveDisplayText } from "@/lib/i18n-text.js";
import { useNotice } from "@/lib/notice-center.js";

/**
 * One card for every plugin of this game that waits for the player's
 * approval. "Review" opens the approval flow for the first of them; the rest
 * follow once it is settled.
 */
export function PluginApprovalNotice({
  plugins,
  sessionId,
  busy,
  onReview,
}: {
  readonly plugins: readonly SessionPlugin[];
  readonly sessionId: string;
  readonly busy: boolean;
  readonly onReview: (pluginId: string) => void;
}): null {
  const { t } = useTranslation();
  const waiting = plugins.filter((plugin) => plugin.approvalRequired);
  const first = waiting[0];
  useNotice(
    first
      ? {
          key: "approval",
          kind: "card",
          tone: "warning",
          scope: sessionId,
          title: t("plugin.approval.cardTitle", { count: waiting.length }),
          body: [
            t("plugin.approval.required"),
            waiting
              .map(
                (plugin) => resolveDisplayText(plugin.displayName) || plugin.id,
              )
              .join(", "),
          ].join("\n"),
          actions: [
            {
              label: t("plugin.approval.reviewAction"),
              disabled: busy,
              onClick: () => onReview(first.id),
            },
          ],
        }
      : null,
  );
  return null;
}
