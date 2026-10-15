import { useTranslation } from "react-i18next";
import type { SessionPlugin } from "@covel/shared";
import { pluginName } from "@/lib/plugin-notices.js";

/**
 * Tells the player the world's dimensions are paused: the plugin that keeps
 * them is not running (not installed, failed to load, or missing a
 * dependency). The story goes on, and the dimensions keep their values until
 * that plugin is back. A provider waiting for approval has its own notice.
 */
export function DimensionProviderNotice({
  providerPluginId,
  plugins,
}: {
  /** `dimensionProviderPluginId` of the session view. */
  readonly providerPluginId: unknown;
  /** The session's plugin list; empty until it has loaded. */
  readonly plugins: readonly SessionPlugin[];
}) {
  const { t } = useTranslation();
  if (typeof providerPluginId !== "string" || plugins.length === 0) return null;
  const provider = plugins.find((plugin) => plugin.id === providerPluginId);
  if (provider?.active || provider?.approvalRequired) return null;
  return (
    <div
      role="status"
      data-testid="dimension-provider-paused"
      className="relative z-10 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs"
    >
      {t("session.dimensionProvider.paused", {
        plugin: pluginName(plugins, providerPluginId),
      })}
    </div>
  );
}
