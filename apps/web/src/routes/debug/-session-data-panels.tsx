import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import i18n from "@/i18n";
import type * as api from "@/services/api.js";
import { fmtTime } from "./-debug-helpers.js";

export function FrameworkDiscoveryPanel({
  framework,
}: {
  framework: Record<string, unknown>;
}) {
  const { t } = useTranslation();
  const pluginManifest = recordValue(framework.pluginManifest);
  const pluginData = recordValue(framework.pluginData);
  const tools = recordValue(framework.tools);
  const worldData = recordValue(framework.worldData);

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-[11px]">
        <DiscoveryMetric
          label={t("debugger.discovery.manifest", "manifest")}
          values={[
            t("debugger.discovery.triggers", {
              count: stringArray(pluginManifest.triggerTypes).length,
              defaultValue: "{{count}} triggers",
            }),
            t("debugger.discovery.outputs", {
              count: stringArray(pluginManifest.outputKinds).length,
              defaultValue: "{{count}} outputs",
            }),
            stringArray(pluginManifest.uiSlots).join(", ") ||
              t("debugger.discovery.noSlots", "no slots"),
          ]}
        />
        <DiscoveryMetric
          label="plugin_data"
          values={[
            String(pluginData.scope ?? ""),
            t("debugger.discovery.writes", {
              count: stringArray(pluginData.writePaths).length,
              defaultValue: "{{count}} writes",
            }),
            t("debugger.discovery.reads", {
              count: stringArray(pluginData.readPaths).length,
              defaultValue: "{{count}} reads",
            }),
          ]}
        />
        <DiscoveryMetric label="tools" values={stringArray(tools.builtin)} />
        <DiscoveryMetric
          label="world_data"
          values={[
            t("debugger.discovery.sources", {
              count: stringArray(worldData.sourceKinds).length,
              defaultValue: "{{count}} sources",
            }),
            t("debugger.discovery.mergeModes", {
              count: stringArray(worldData.mergeModes).length,
              defaultValue: "{{count}} merge modes",
            }),
            t("debugger.discovery.targets", {
              count: stringArray(worldData.targetUris).length,
              defaultValue: "{{count}} targets",
            }),
          ]}
        />
      </div>
      <JsonBlock data={framework} />
    </div>
  );
}

export function PluginContractsPanel({
  plugins,
}: {
  plugins: api.PluginContract[];
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      {plugins.map((plugin) => {
        const pluginDescription = displayText(plugin.description);
        const builtinTools = plugin.tools?.builtin ?? [];
        const localTools = plugin.tools?.local ?? [];
        const uiCount =
          (plugin.ui?.right?.length ?? 0) +
          (plugin.ui?.message?.length ?? 0) +
          (plugin.ui?.left?.length ?? 0);
        return (
          <div key={plugin.id} className="border border-border p-2 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold font-mono">
                {plugin.id}
              </span>
              {plugin.status && (
                <Badge variant="outline" className="text-[9px]">
                  {plugin.status}
                </Badge>
              )}
              {plugin.runtimeCount != null && (
                <Badge variant="secondary" className="text-[9px]">
                  {t("debugger.discovery.runtimeCount", {
                    count: plugin.runtimeCount,
                    defaultValue: "{{count}} runtime",
                  })}
                </Badge>
              )}
            </div>
            {pluginDescription && (
              <p className="text-[11px] text-muted-foreground">
                {pluginDescription}
              </p>
            )}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              <DiscoveryMetric
                label={t("debugger.discovery.capabilities", "capabilities")}
                values={plugin.capabilities ?? []}
              />
              <DiscoveryMetric
                label="plugin_data"
                values={plugin.declaredPluginDataNamespaces ?? []}
              />
              <DiscoveryMetric
                label={t("debugger.discovery.tools", "tools")}
                values={[
                  ...builtinTools.map((name) => `builtin:${name}`),
                  ...localTools.map((tool) => `local:${tool.name}`),
                ]}
              />
              <DiscoveryMetric
                label={t("debugger.discovery.extension", "extension")}
                values={[
                  t("debugger.discovery.rpc", {
                    count: plugin.rpc?.length ?? 0,
                    defaultValue: "{{count}} rpc",
                  }),
                  t("debugger.discovery.ui", {
                    count: uiCount,
                    defaultValue: "{{count}} ui",
                  }),
                  t("debugger.discovery.schemas", {
                    count: Object.keys(plugin.dataSchemas ?? {}).length,
                    defaultValue: "{{count}} schemas",
                  }),
                ]}
              />
            </div>
            <JsonBlock data={plugin} />
          </div>
        );
      })}
    </div>
  );
}

export function PluginDataIndexPanel({
  pluginData,
}: {
  pluginData: api.PluginDataDiscoveryIndex[];
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      {pluginData
        .filter((entry) => entry.namespaces.length > 0)
        .map((entry) => (
          <div key={entry.pluginId} className="border border-border p-2">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs font-semibold font-mono">
                {entry.pluginId}
              </span>
              <Badge variant="outline" className="text-[9px]">
                {t("debugger.discovery.namespaces", {
                  count: entry.namespaces.length,
                  defaultValue: "{{count}} namespaces",
                })}
              </Badge>
            </div>
            <div className="space-y-2">
              {entry.namespaces.map((namespace) => (
                <div
                  key={namespace.namespace}
                  className="bg-muted/10 border border-border/60 p-2"
                >
                  <div className="flex flex-wrap items-center gap-2 mb-1">
                    <span className="text-[11px] font-mono">
                      {namespace.namespace}
                    </span>
                    <Badge variant="secondary" className="text-[9px]">
                      {t("debugger.discovery.keys", {
                        count: namespace.count,
                        defaultValue: "{{count}} keys",
                      })}
                    </Badge>
                    {namespace.latestUpdatedAt && (
                      <span className="text-[9px] text-muted-foreground">
                        {fmtTime(namespace.latestUpdatedAt, {
                          withMillis: false,
                          alwaysDate: true,
                        })}
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-1">
                    {namespace.keys.map((key) => (
                      <div
                        key={key.key}
                        className="flex items-center justify-between gap-2 text-[10px] font-mono text-muted-foreground"
                      >
                        <span className="truncate">{key.key}</span>
                        <Badge variant="outline" className="text-[9px]">
                          {key.valueType}
                        </Badge>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
    </div>
  );
}

export function DataSection({
  title,
  icon,
  children,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(true);
  return (
    <div className="border border-border">
      <button
        onClick={() => setExpanded((value) => !value)}
        className="w-full flex items-center gap-2 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground ui-rail"
      >
        {expanded ? (
          <ChevronDown className="w-3 h-3" />
        ) : (
          <ChevronRight className="w-3 h-3" />
        )}
        {icon}
        {title}
      </button>
      {expanded && <div className="p-3 space-y-2">{children}</div>}
    </div>
  );
}

export function JsonBlock({ data }: { data: unknown }) {
  return (
    <pre className="text-[10px] font-mono text-muted-foreground bg-muted/10 p-2 overflow-x-auto whitespace-pre-wrap break-all">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

function DiscoveryMetric({
  label,
  values,
}: {
  label: string;
  values: string[];
}) {
  const { t } = useTranslation();
  return (
    <div className="border border-border/60 bg-muted/10 p-2 min-w-0">
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground mb-1">
        {label}
      </div>
      <div className="flex flex-wrap gap-1">
        {values.length === 0 ? (
          <span className="text-[10px] text-muted-foreground italic">
            {t("debugger.discovery.empty", "empty")}
          </span>
        ) : (
          values.map((value) => (
            <Badge
              key={value}
              variant="outline"
              className="text-[9px] max-w-full truncate"
            >
              {value}
            </Badge>
          ))
        )}
      </div>
    </div>
  );
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function displayText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const record = value as Record<string, unknown>;
  const locale = i18n.language || "zh-CN";
  for (const key of [
    locale,
    locale.split("-")[0],
    "zh-CN",
    "zh",
    "en-US",
    "en",
  ]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  const fallback = Object.values(record).find(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate.length > 0,
  );
  return fallback ?? "";
}
