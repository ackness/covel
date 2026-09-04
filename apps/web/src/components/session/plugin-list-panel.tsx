import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { stageRank } from "@covel/shared";
import { getDataService } from "@/services/data-service.js";
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
}: PluginListPanelProps) {
  const { t } = useTranslation();
  const [effectiveOverrides, setEffectiveOverrides] = useState<
    Record<string, string>
  >(() => runtimeModelOverrides ?? {});
  const overridesRef = useRef(effectiveOverrides);
  const confirmedOverridesRef = useRef(effectiveOverrides);
  const saveTailRef = useRef<Promise<void>>(Promise.resolve());
  const revisionRef = useRef(0);
  const generationRef = useRef(0);
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;
  overridesRef.current = effectiveOverrides;

  useEffect(() => {
    const next = runtimeModelOverrides ?? {};
    generationRef.current += 1;
    revisionRef.current = 0;
    saveTailRef.current = Promise.resolve();
    confirmedOverridesRef.current = next;
    overridesRef.current = next;
    setEffectiveOverrides(next);
  }, [sessionId, runtimeModelOverrides]);

  const updateRuntimeModelOverride = useCallback(
    (runtimeKey: string, slot: string): Promise<void> => {
      if (!sessionId || !runtimeKey) return Promise.resolve();
      const next = { ...overridesRef.current };
      if (slot) next[runtimeKey] = slot;
      else delete next[runtimeKey];
      const revision = ++revisionRef.current;
      const generation = generationRef.current;
      overridesRef.current = next;
      setEffectiveOverrides(next);

      const operation = saveTailRef.current
        .catch(() => undefined)
        .then(() =>
          getDataService().updateSession(sessionId, {
            runtimeModelOverrides: next,
          }),
        );
      saveTailRef.current = operation.then(
        () => undefined,
        () => undefined,
      );

      return operation.then(
        (updated) => {
          if (
            sessionRef.current !== sessionId ||
            generationRef.current !== generation
          )
            return;
          const confirmed = updated.runtimeModelOverrides ?? next;
          confirmedOverridesRef.current = confirmed;
          if (revisionRef.current === revision) {
            overridesRef.current = confirmed;
            setEffectiveOverrides(confirmed);
          }
        },
        (error: unknown) => {
          if (
            sessionRef.current === sessionId &&
            generationRef.current === generation &&
            revisionRef.current === revision
          ) {
            const confirmed = confirmedOverridesRef.current;
            overridesRef.current = confirmed;
            setEffectiveOverrides(confirmed);
          }
          throw error;
        },
      );
    },
    [sessionId],
  );

  const hasSessionPlugins = (sessionPlugins ?? []).length > 0;

  if (plugins.length === 0 && loadErrors.length === 0 && !hasSessionPlugins) {
    return (
      <p className="text-xs text-muted-foreground italic">
        {t("session.noPluginsLoaded")}
      </p>
    );
  }

  const sessionPluginMap = new Map<string, SessionPlugin>(
    (sessionPlugins ?? []).map((p) => [p.id, p]),
  );
  const useDetailView = plugins.length === 0 && hasSessionPlugins;
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
              plugin={sp}
              executing={executing}
              onToggle={onTogglePlugin}
              resolvedSlots={resolvedSlots}
              sessionId={sessionId}
              runtimeModelOverrides={effectiveOverrides}
              onRuntimeModelOverrideChange={updateRuntimeModelOverride}
              setupRuntimes={setupRuntimes}
            />
          ))
        : plugins.map((pkg) => (
            <PluginItem
              key={pkg.id}
              pkg={pkg}
              sessionPlugin={sessionPluginMap.get(pkg.id)}
              executing={executing}
              onToggle={onTogglePlugin}
              resolvedSlots={resolvedSlots}
              sessionId={sessionId}
              runtimeModelOverrides={effectiveOverrides}
              onRuntimeModelOverrideChange={updateRuntimeModelOverride}
              setupRuntimes={setupRuntimes}
            />
          ))}
    </div>
  );
}
