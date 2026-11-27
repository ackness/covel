import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  PluginPanel,
  type PluginPanelStateCache,
} from "@/components/session/plugin-panel.js";
import { openExternalUrl } from "@/lib/desktop-bridge.js";
import {
  bumpPlatformInstanceDataVersion,
  openPluginAppPage,
  openPluginConfigFlow,
  openPluginWindow,
  usePlatformUiState,
} from "@/lib/platform-ui-events.js";
import { emitToast } from "@/lib/toast-channel.js";
import {
  fetchPluginInstanceData,
  invokePluginAppAction,
  type UISlotSpec,
} from "@/services/api.js";

function toNamespaceMap(
  entries: readonly { key: string; value: unknown }[],
): Record<string, unknown> {
  return Object.fromEntries(entries.map((entry) => [entry.key, entry.value]));
}

function isReadableNamespace(namespace: unknown): namespace is string {
  return (
    typeof namespace === "string" &&
    namespace.trim().length > 0 &&
    !namespace.startsWith("_")
  );
}

export async function runPluginAppAction(
  pluginId: string,
  action: string,
  input?: Record<string, unknown>,
) {
  const res = await invokePluginAppAction(pluginId, action, input);
  bumpPlatformInstanceDataVersion();
  const resultObj =
    res.result && typeof res.result === "object"
      ? (res.result as Record<string, unknown>)
      : undefined;
  if (typeof resultObj?.message === "string" && resultObj.message) {
    emitToast("info", resultObj.message);
  }
  return res;
}

export function collectInstanceNamespaces(spec: UISlotSpec | null): {
  primaryNamespace?: string;
  bindings: Record<string, string>;
} {
  if (!spec) return { bindings: {} };
  const ds = spec.dataSource as
    { namespace?: unknown; bindings?: Record<string, unknown> } | undefined;
  const primaryNamespace = isReadableNamespace(ds?.namespace)
    ? ds.namespace
    : undefined;
  const bindings: Record<string, string> = {};
  for (const rawBindings of [ds?.bindings, spec.sources]) {
    if (!rawBindings || typeof rawBindings !== "object") continue;
    for (const [alias, ns] of Object.entries(rawBindings)) {
      if (isReadableNamespace(ns)) {
        bindings[alias] = ns;
      }
    }
  }
  return {
    ...(primaryNamespace ? { primaryNamespace } : {}),
    bindings,
  };
}

export function useInstancePluginPanelBinding(params: {
  readonly pluginId: string;
  readonly spec: UISlotSpec | null;
  readonly enabled?: boolean;
}) {
  const { pluginId, spec, enabled = true } = params;
  const { t } = useTranslation();
  const { instanceDataVersion } = usePlatformUiState();
  const [namespaceData, setNamespaceData] = useState<
    Record<string, Record<string, unknown>>
  >({});

  const { primaryNamespace, bindings } = useMemo(
    () => collectInstanceNamespaces(spec),
    [spec],
  );
  const namespacesKey = useMemo(() => {
    const unique = new Set<string>();
    if (primaryNamespace) unique.add(primaryNamespace);
    for (const ns of Object.values(bindings)) unique.add(ns);
    return [...unique].sort().join("\u001f");
  }, [primaryNamespace, bindings]);

  useEffect(() => {
    if (!enabled || !pluginId || !namespacesKey) {
      setNamespaceData({});
      return;
    }
    const namespaces = namespacesKey.split("\u001f").filter(Boolean);
    let cancelled = false;
    void Promise.all(
      namespaces.map(async (ns) => {
        try {
          const res = await fetchPluginInstanceData(pluginId, ns);
          return [ns, toNamespaceMap(res.entries)] as const;
        } catch {
          return [ns, {}] as const;
        }
      }),
    ).then((pairs) => {
      if (!cancelled) {
        setNamespaceData(Object.fromEntries(pairs));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, pluginId, namespacesKey, instanceDataVersion]);

  const stateOverride = useMemo<Record<string, unknown>>(
    () => (primaryNamespace ? (namespaceData[primaryNamespace] ?? {}) : {}),
    [namespaceData, primaryNamespace],
  );

  const sourcesOverride = useMemo<Record<string, Record<string, unknown>>>(
    () =>
      Object.fromEntries(
        Object.entries(bindings).map(([alias, ns]) => [
          alias,
          namespaceData[ns] ?? {},
        ]),
      ),
    [bindings, namespaceData],
  );

  const handlers = useMemo<
    Record<string, (params: Record<string, unknown>) => Promise<unknown>>
  >(
    () => ({
      appAction: async (callParams) => {
        const action =
          typeof callParams.action === "string" ? callParams.action : undefined;
        if (!action) return { ok: false };
        const rawInput =
          callParams.input && typeof callParams.input === "object"
            ? (callParams.input as Record<string, unknown>)
            : callParams.payload && typeof callParams.payload === "object"
              ? (callParams.payload as Record<string, unknown>)
              : undefined;
        try {
          return await runPluginAppAction(pluginId, action, rawInput);
        } catch (err) {
          emitToast("error", err instanceof Error ? err.message : String(err));
          return { ok: false };
        }
      },
      openFlow: async (callParams) => {
        const flowId =
          typeof callParams.flowId === "string" ? callParams.flowId : undefined;
        if (!flowId) return { ok: false };
        const initial =
          callParams.initial &&
          typeof callParams.initial === "object" &&
          !Array.isArray(callParams.initial)
            ? (callParams.initial as Record<string, unknown>)
            : undefined;
        openPluginConfigFlow(pluginId, flowId, initial);
        return { ok: true };
      },
      openPage: async (callParams) => {
        const pageId =
          typeof callParams.pageId === "string" ? callParams.pageId : undefined;
        if (!pageId) return { ok: false };
        openPluginAppPage(pluginId, pageId);
        return { ok: true };
      },
      openWindow: async (callParams) => {
        const windowId =
          typeof callParams.windowId === "string"
            ? callParams.windowId
            : undefined;
        if (!windowId) return { ok: false };
        openPluginWindow(pluginId, windowId);
        return { ok: true };
      },
      openExternal: async (callParams) => {
        const url = typeof callParams.url === "string" ? callParams.url : "";
        if (!url) return { ok: false };
        const ok = await openExternalUrl(url);
        if (!ok) {
          emitToast(
            "error",
            t("platform.openExternalFailed", "Could not open external URL"),
          );
        }
        return { ok };
      },
    }),
    [pluginId, t],
  );

  return { stateOverride, sourcesOverride, handlers };
}

export function InstancePluginPanel({
  pluginId,
  panelId,
  spec,
  forbidWebview = false,
  fill = false,
  expanded = false,
  stateCache,
}: {
  readonly pluginId: string;
  readonly panelId?: string;
  readonly spec: UISlotSpec;
  readonly forbidWebview?: boolean;
  readonly fill?: boolean;
  readonly expanded?: boolean;
  readonly stateCache?: PluginPanelStateCache;
}) {
  const { t } = useTranslation();
  const { stateOverride, sourcesOverride, handlers } =
    useInstancePluginPanelBinding({
      pluginId,
      spec,
      enabled: !(forbidWebview && spec.webview),
    });

  const effectiveSpec = useMemo(
    () =>
      ({
        ...spec,
        alwaysRender: spec.alwaysRender ?? (spec.emptyState === undefined),
      }) as Record<string, unknown>,
    [spec],
  );

  if (forbidWebview && spec.webview) {
    return (
      <p className="text-xs text-muted-foreground italic">
        {t(
          "platform.webviewNotAllowed",
          "Webviews are not permitted in this slot.",
        )}
      </p>
    );
  }

  return (
    <PluginPanel
      pluginId={pluginId}
      panelId={panelId ?? spec.id}
      spec={effectiveSpec}
      stateOverride={stateOverride}
      sourcesOverride={sourcesOverride}
      handlers={handlers}
      fill={fill}
      expanded={expanded}
      stateCache={stateCache}
    />
  );
}
