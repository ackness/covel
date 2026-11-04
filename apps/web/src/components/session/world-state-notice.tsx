import { useTranslation } from "react-i18next";
import type { SessionPlugin, WorldDataImportNotice } from "@covel/shared";
import { pluginName } from "@/lib/plugin-notices.js";
import { useNotice } from "@/lib/notice-center.js";
import { useSession } from "@/stores/session-store.js";
import { SessionDimensionsPanel } from "./session-dimensions-panel.js";

/**
 * One card for everything wrong with the world state: nothing keeps it
 * (no plugin for it, or the one that does is not running), and turns whose
 * state changes still wait to be settled, which the card lets the player
 * retry or edit. The story goes on meanwhile, and the values stay as they are.
 */
export function WorldStateNotice({
  providerPluginId,
  plugins,
  notices,
  sessionId,
}: {
  /** `dimensionProviderPluginId` of the session view. */
  readonly providerPluginId: unknown;
  /** The session's plugin list; empty until it has loaded. */
  readonly plugins: readonly SessionPlugin[];
  readonly notices: readonly WorldDataImportNotice[];
  readonly sessionId: string;
}): null {
  const { t } = useTranslation();
  const { state } = useSession();
  const provider =
    typeof providerPluginId === "string" && plugins.length > 0
      ? plugins.find((plugin) => plugin.id === providerPluginId)
      : undefined;
  // A provider waiting for approval is part of the approval card.
  const paused =
    typeof providerPluginId === "string" &&
    plugins.length > 0 &&
    !provider?.active &&
    !provider?.approvalRequired;
  const nobodyKeepsIt = notices.some(
    (notice) => notice.code === "dimension-provider-missing",
  );
  const settlements = state.gameState.dimensionSettlements;
  const pending =
    Array.isArray(settlements) &&
    settlements.some(
      (receipt) =>
        (receipt as { status?: unknown } | null)?.status ===
        "pending-settlement",
    );
  const lines = [
    ...(paused
      ? [
          t("session.dimensionProvider.paused", {
            plugin: pluginName(plugins, providerPluginId),
          }),
        ]
      : []),
    ...(nobodyKeepsIt ? [t("session.worldDataNotices.dimensionsMissing")] : []),
  ];
  useNotice(
    lines.length > 0 || pending
      ? {
          key: "world-state",
          kind: "card",
          tone: "warning",
          scope: sessionId,
          title: t("session.worldStateNotice.title"),
          ...(lines.length > 0 ? { body: lines.join("\n") } : {}),
          ...(pending
            ? {
                render: () => (
                  <div className="-mx-3 -mb-3 -mt-2">
                    <SessionDimensionsPanel recoveryOnly />
                  </div>
                ),
              }
            : {}),
        }
      : null,
  );
  return null;
}
