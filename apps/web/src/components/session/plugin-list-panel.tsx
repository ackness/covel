import { useTranslation } from "react-i18next";
import type { SessionPluginInfo } from "@/services/api.js";
import { PluginErrorItem } from "./plugin-list-panel/plugin-error-item.js";
import { PluginItem } from "./plugin-list-panel/plugin-item.js";
import { SessionPluginItem } from "./plugin-list-panel/session-plugin-item.js";
import type { PluginListPanelProps } from "./plugin-list-panel/types.js";

export function PluginListPanel({
  packages,
  loadErrors = [],
  sessionPlugins,
  executing,
  onTogglePlugin,
  resolvedSlots,
  sessionId,
  runtimeModelOverrides,
  setupRuntimes,
}: PluginListPanelProps) {
  const { t } = useTranslation();

  const hasSessionPlugins = (sessionPlugins ?? []).length > 0;

  if (packages.length === 0 && loadErrors.length === 0 && !hasSessionPlugins) {
    return (
      <p className="text-xs text-muted-foreground italic">
        {t("session.noPluginsLoaded")}
      </p>
    );
  }

  const sessionPluginMap = new Map<string, SessionPluginInfo>(
    (sessionPlugins ?? []).map((p) => [p.id, p]),
  );
  const useDetailView = packages.length === 0 && hasSessionPlugins;
  const sortedPlugins = useDetailView
    ? [...(sessionPlugins ?? [])].sort(
        (a, b) => (a.priority ?? 500) - (b.priority ?? 500),
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
              plugin={sp}
              executing={executing}
              onToggle={onTogglePlugin}
              resolvedSlots={resolvedSlots}
              sessionId={sessionId}
              runtimeModelOverrides={runtimeModelOverrides}
              setupRuntimes={setupRuntimes}
            />
          ))
        : packages.map((pkg) => (
            <PluginItem
              key={pkg.name}
              pkg={pkg}
              sessionPlugin={sessionPluginMap.get(pkg.name)}
              executing={executing}
              onToggle={onTogglePlugin}
              resolvedSlots={resolvedSlots}
              sessionId={sessionId}
              runtimeModelOverrides={runtimeModelOverrides}
              setupRuntimes={setupRuntimes}
            />
          ))}
    </div>
  );
}
