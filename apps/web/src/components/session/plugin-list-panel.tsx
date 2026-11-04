import { useTranslation } from "react-i18next";
import { stageRank } from "@covel/shared";
import type { SessionPlugin } from "@/services/api.js";
import { PluginErrorItem } from "./plugin-list-panel/plugin-error-item.js";
import { PluginItem } from "./plugin-list-panel/plugin-item.js";
import { SessionPluginItem } from "./plugin-list-panel/session-plugin-item.js";
import type { PluginListPanelProps } from "./plugin-list-panel/types.js";

export function PluginListPanel({
  plugins,
  loadErrors = [],
  sessionPlugins,
  executing,
  onTogglePlugin,
  resolvedSlots,
  sessionId,
  runtimeModelOverrides,
  setupRuntimes,
  developerMode = false,
  onOpenModelSettings,
}: PluginListPanelProps) {
  const { t } = useTranslation();

  const hasSessionPlugins = (sessionPlugins ?? []).length > 0;

  if (plugins.length === 0 && loadErrors.length === 0 && !hasSessionPlugins) {
    return (
      <div className="space-y-1.5">
        <p className="text-xs text-muted-foreground italic">
          {t("session.noPluginsLoaded")}
        </p>
      </div>
    );
  }

  const sessionPluginMap = new Map<string, SessionPlugin>(
    (sessionPlugins ?? []).map((p) => [p.id, p]),
  );
  // The session catalogue carries the effective active/locked/runtime metadata.
  // Global packages can include plugins that this world never selected.
  const useDetailView = sessionPlugins !== undefined;
  const sortedPlugins = useDetailView
    ? [...(sessionPlugins ?? [])].sort(
        (a, b) =>
          Math.min(...a.runtimes.map((runtime) => stageRank(runtime.stage))) -
            Math.min(
              ...b.runtimes.map((runtime) => stageRank(runtime.stage)),
            ) || a.id.localeCompare(b.id),
      )
    : [];

  return (
    <div className="space-y-1.5">
      {loadErrors.length > 0 && (
        <div className="space-y-1.5">
          {loadErrors.map((err) => (
            <PluginErrorItem key={err.pluginId} error={err} />
          ))}
        </div>
      )}
      {useDetailView
        ? sortedPlugins.map((sp) => (
            <SessionPluginItem
              key={sp.id}
              advanced={developerMode}
              plugin={sp}
              executing={executing}
              onToggle={onTogglePlugin}
              resolvedSlots={resolvedSlots}
              sessionId={sessionId}
              runtimeModelOverrides={runtimeModelOverrides}
              onOpenModelSettings={onOpenModelSettings}
              setupRuntimes={setupRuntimes}
            />
          ))
        : plugins.map((pkg) => (
            <PluginItem
              key={pkg.id}
              advanced={developerMode}
              pkg={pkg}
              sessionPlugin={sessionPluginMap.get(pkg.id)}
              executing={executing}
              onToggle={onTogglePlugin}
              resolvedSlots={resolvedSlots}
              sessionId={sessionId}
              runtimeModelOverrides={runtimeModelOverrides}
              onOpenModelSettings={onOpenModelSettings}
              setupRuntimes={setupRuntimes}
            />
          ))}
    </div>
  );
}
