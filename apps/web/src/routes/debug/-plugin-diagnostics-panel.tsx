import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  PluginDiagnostic,
  PluginDiagnosticsSnapshot,
} from "@covel/shared";
import { Button } from "@/components/ui/button.js";
import { getPluginDiagnostics } from "@/services/api.js";

interface LoadedSnapshot {
  key: string;
  value: PluginDiagnosticsSnapshot;
}

export function PluginDiagnosticsPanel({
  sessionId,
  pluginId,
  autoRefresh,
  refreshSignal,
  onPluginFilterChange,
}: {
  sessionId: string | null;
  pluginId?: string;
  autoRefresh: boolean;
  refreshSignal: number;
  onPluginFilterChange: (pluginId?: string) => void;
}) {
  const { t } = useTranslation();
  const key = JSON.stringify([sessionId, pluginId]);
  const currentKey = useRef(key);
  const epoch = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const [loaded, setLoaded] = useState<LoadedSnapshot | null>(null);
  const [status, setStatus] = useState<{
    key: string;
    value: "loading" | "ready" | "error";
  } | null>(null);

  // Invalidate responses during render, before an effect can run for a new URL.
  if (currentKey.current !== key) {
    currentKey.current = key;
    epoch.current += 1;
    controller.current?.abort();
  }

  const refresh = useCallback(
    async (skipIfBusy = false) => {
      if (!sessionId) return;
      if (skipIfBusy && controller.current) return;
      controller.current?.abort();
      const nextController = new AbortController();
      controller.current = nextController;
      const requestEpoch = ++epoch.current;
      setLoaded(null);
      setStatus({ key, value: "loading" });
      try {
        const value = await getPluginDiagnostics(
          sessionId,
          pluginId,
          nextController.signal,
        );
        if (currentKey.current !== key || epoch.current !== requestEpoch)
          return;
        setLoaded({ key, value });
        setStatus({ key, value: "ready" });
      } catch {
        if (currentKey.current !== key || epoch.current !== requestEpoch)
          return;
        setLoaded(null);
        setStatus({ key, value: "error" });
      } finally {
        if (controller.current === nextController) controller.current = null;
      }
    },
    [key, pluginId, sessionId],
  );

  useEffect(() => {
    void refresh();
    return () => {
      epoch.current += 1;
      controller.current?.abort();
    };
  }, [refresh, refreshSignal]);

  useEffect(() => {
    if (!autoRefresh || !sessionId) return;
    const interval = setInterval(() => void refresh(true), 3000);
    return () => clearInterval(interval);
  }, [autoRefresh, refresh, sessionId]);

  const snapshot = loaded?.key === key ? loaded.value : null;
  const currentStatus = status?.key === key ? status.value : "loading";

  if (!sessionId) {
    return (
      <div className="p-5 text-sm text-muted-foreground">
        {t(
          "debugger.plugins.selectSession",
          "Select a session to inspect plugins.",
        )}
      </div>
    );
  }

  return (
    <section
      className="flex-1 min-w-0 overflow-y-auto p-3 sm:p-5"
      aria-label={t("debugger.plugins.tab", "Plugins")}
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="ui-title text-base font-semibold">
            {t("debugger.plugins.title", "Plugin diagnostics")}
          </h2>
          {pluginId && (
            <p className="mt-1 font-mono text-xs text-muted-foreground break-all">
              {pluginId}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {pluginId && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onPluginFilterChange()}
            >
              {t("debugger.plugins.showAll", "Show all")}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => void refresh()}>
            {t("debugger.refresh", "Refresh")}
          </Button>
        </div>
      </div>

      {currentStatus === "loading" && (
        <p role="status" className="text-sm text-muted-foreground">
          {t("debugger.plugins.loading", "Loading plugin diagnostics…")}
        </p>
      )}
      {currentStatus === "error" && (
        <div
          role="alert"
          className="rounded border border-destructive/40 p-4 text-sm"
        >
          {t(
            "debugger.plugins.error",
            "Plugin diagnostics could not be loaded. Refresh to retry.",
          )}
        </div>
      )}
      {snapshot && (
        <>
          <p className="mb-3 text-xs text-muted-foreground">
            {t("debugger.plugins.installedCount", {
              count: snapshot.plugins.length,
              defaultValue: "{{count}} installed plugins",
            })}
            {" · "}
            {t("debugger.plugins.historyLimit", {
              count: snapshot.history.limit,
              defaultValue:
                "Last {{count}} completed service calls (process memory)",
            })}
          </p>
          {snapshot.plugins.length === 0 ? (
            <p className="rounded border border-(--rule-color) p-4 text-sm text-muted-foreground">
              {pluginId
                ? t(
                    "debugger.plugins.noMatch",
                    "No installed plugin matches this filter.",
                  )
                : t("debugger.plugins.empty", "No plugins are installed.")}
            </p>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {snapshot.plugins.map((plugin) => (
                <PluginCard
                  key={plugin.pluginId}
                  plugin={plugin}
                  filtered={!!pluginId}
                  onFilter={() => onPluginFilterChange(plugin.pluginId)}
                />
              ))}
            </div>
          )}
          <h3 className="ui-title mb-2 mt-6 text-sm font-semibold">
            {t("debugger.plugins.calls", "Recent service calls")}
          </h3>
          {snapshot.calls.length === 0 ? (
            <p className="rounded border border-(--rule-color) p-4 text-sm text-muted-foreground">
              {t(
                "debugger.plugins.noCalls",
                "No completed service calls in this process window.",
              )}
            </p>
          ) : (
            <div className="max-w-full overflow-x-auto rounded border border-(--rule-color)">
              <table className="min-w-190 w-full text-left text-xs">
                <thead className="bg-(--surface-inset) text-muted-foreground">
                  <tr>
                    <th className="p-2">
                      {t("debugger.plugins.completed", "Completed")}
                    </th>
                    <th className="p-2">
                      {t("debugger.plugins.caller", "Caller → provider")}
                    </th>
                    <th className="p-2">
                      {t("debugger.plugins.service", "Service")}
                    </th>
                    <th className="p-2">
                      {t("debugger.plugins.outcome", "Outcome")}
                    </th>
                    <th className="p-2">
                      {t("debugger.plugins.duration", "Duration")}
                    </th>
                    <th className="p-2">
                      {t("debugger.plugins.context", "Call / parent / turn")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.calls.map((call) => (
                    <tr
                      key={call.callId}
                      className="border-t border-(--rule-color) align-top"
                    >
                      <td className="p-2 whitespace-nowrap">
                        {call.completedAt}
                      </td>
                      <td className="p-2 font-mono break-all">
                        {call.callerPluginId} → {call.providerPluginId}
                      </td>
                      <td className="p-2 font-mono break-all">
                        {call.name}
                        <br />
                        <span className="text-muted-foreground">
                          {call.contract}
                        </span>
                      </td>
                      <td className="p-2">
                        {call.outcome}
                        {call.errorCode ? ` · ${call.errorCode}` : ""}
                      </td>
                      <td className="p-2 whitespace-nowrap">
                        {call.durationMs} ms
                      </td>
                      <td className="p-2 font-mono break-all">
                        {call.callId}
                        <br />
                        {call.parentCallId ?? "—"}
                        <br />
                        {call.turnId ?? "—"}
                        {call.runtimeId ? ` · ${call.runtimeId}` : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function PluginCard({
  plugin,
  filtered,
  onFilter,
}: {
  plugin: PluginDiagnostic;
  filtered: boolean;
  onFilter: () => void;
}) {
  const { t } = useTranslation();
  const { registrations } = plugin;
  return (
    <article className="min-w-0 rounded border border-(--rule-color) p-3 text-xs">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-mono text-sm font-semibold break-all">
            {plugin.pluginId}
          </h3>
          <p className="text-muted-foreground">
            {plugin.source} · {plugin.state}
          </p>
        </div>
        {!filtered && (
          <Button variant="ghost" size="sm" onClick={onFilter}>
            {t("debugger.plugins.filter", "Filter")}
          </Button>
        )}
      </div>
      <dl className="grid gap-2 sm:grid-cols-2">
        <Capability
          label={t("debugger.plugins.runtimes", "Runtimes")}
          values={plugin.runtimeIds}
        />
        <Capability
          label={t("debugger.plugins.tools", "Tools")}
          values={registrations.tools}
        />
        <Capability
          label={t("debugger.plugins.hooks", "Hooks")}
          values={registrations.hooks.map(
            (hook) => `${hook.id} (${hook.event})`,
          )}
        />
        <Capability
          label={t("debugger.plugins.actions", "Actions")}
          values={registrations.actions}
        />
        <Capability
          label={t("debugger.plugins.services", "Services")}
          values={registrations.services.map(
            (service) => `${service.name} (${service.contract})`,
          )}
        />
        <Capability
          label={t("debugger.plugins.commands", "Commands")}
          values={plugin.commands.map(
            (command) =>
              `/${command.name} → ${command.action} · ${command.registered ? t("debugger.plugins.registered", "registered") : t("debugger.plugins.unregistered", "unregistered")}`,
          )}
        />
      </dl>
    </article>
  );
}

function Capability({
  label,
  values,
}: {
  label: string;
  values: readonly string[];
}) {
  return (
    <div className="min-w-0">
      <dt className="mb-1 text-muted-foreground">{label}</dt>
      <dd className="font-mono break-all">
        {values.length ? values.join(", ") : "—"}
      </dd>
    </div>
  );
}
