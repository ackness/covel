import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Puzzle, Wrench, Zap, Link, AlertTriangle, Lock } from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import { text } from "@/components/world/editor-helpers.js";
import type { PackageSummary, PluginLoadError, SessionPluginInfo } from "@/services/api.js";

interface PluginListPanelProps {
  packages: PackageSummary[];
  loadErrors?: PluginLoadError[];
  /** Session-scoped plugin info with live isActive state. */
  sessionPlugins?: SessionPluginInfo[];
  /** Whether a turn is currently executing (disables toggles mid-turn). */
  executing?: boolean;
  /** Called when the user flips the enable/disable switch. */
  onTogglePlugin?: (pluginId: string, enable: boolean) => void;
}

const TRIGGER_LABELS: Record<string, { key: string; fallback: string }> = {
  always: { key: "plugin.triggerAlways", fallback: "Always" },
  interval: { key: "plugin.triggerInterval", fallback: "Interval" },
  manual: { key: "plugin.triggerManual", fallback: "Manual" },
  event: { key: "plugin.triggerEvent", fallback: "Event" },
};

interface PluginItemProps {
  pkg: PackageSummary;
  sessionPlugin?: SessionPluginInfo;
  executing?: boolean;
  onToggle?: (pluginId: string, enable: boolean) => void;
}

function PluginItem({ pkg, sessionPlugin, executing, onToggle }: PluginItemProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const displayName = text(pkg.displayName) || pkg.name;
  const description = text(pkg.description);
  const runtimes = pkg.runtimes ?? [];
  const tools = pkg.tools ?? [];
  const requires = pkg.requires ?? [];
  const mainRuntime = runtimes[0];

  const hasSessionScope = sessionPlugin !== undefined;
  const isActive = sessionPlugin?.isActive ?? true;
  const isLocked = sessionPlugin?.locked === true;
  const toggleDisabled = executing === true || isLocked;

  return (
    <div className="border border-border rounded-md overflow-hidden">
      {/* Header row */}
      <button
        type="button"
        className="w-full flex items-center gap-2 px-2.5 py-2 text-left hover:bg-muted/50 transition-colors"
        onClick={() => setExpanded((v) => !v)}
      >
        <ChevronRight
          className={`w-3 h-3 shrink-0 text-muted-foreground transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
        />
        <Puzzle className="w-3.5 h-3.5 shrink-0 text-primary/60" />
        <span className="text-xs font-medium truncate flex-1">{displayName}</span>
        {mainRuntime && (
          <Badge variant="secondary" className="text-[9px] px-1.5 py-0 h-4 shrink-0">
            P{mainRuntime.priority}
          </Badge>
        )}
        {/* Lock icon for core plugins */}
        {isLocked && (
          <span title={t("plugin.locked", "Core plugin — cannot be disabled")}>
            <Lock className="w-3 h-3 shrink-0 text-muted-foreground/50" />
          </span>
        )}
        {/* Toggle switch — only shown when session plugin data is available and not locked */}
        {hasSessionScope && onToggle && !isLocked && (
          <button
            type="button"
            role="switch"
            aria-checked={isActive}
            aria-label={isActive
              ? t("plugin.disable", "Disable plugin")
              : t("plugin.enable", "Enable plugin")}
            disabled={toggleDisabled}
            className={[
              "relative inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent",
              "transition-colors duration-200 ease-in-out focus-visible:outline-none focus-visible:ring-2",
              "focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              isActive ? "bg-primary" : "bg-input",
              toggleDisabled ? "opacity-50 cursor-not-allowed" : "",
            ].join(" ")}
            onClick={(e) => {
              e.stopPropagation();
              if (!toggleDisabled) {
                onToggle(pkg.name, !isActive);
              }
            }}
          >
            <span
              className={[
                "pointer-events-none inline-block h-3 w-3 rounded-full bg-background shadow-lg",
                "ring-0 transition duration-200 ease-in-out",
                isActive ? "translate-x-3" : "translate-x-0",
              ].join(" ")}
            />
          </button>
        )}
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-3 pb-2.5 pt-0.5 space-y-2 border-t border-border bg-muted/20">
          {/* Description */}
          {description && (
            <p className="text-[11px] text-muted-foreground leading-relaxed">{description}</p>
          )}

          {/* Meta info */}
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
            {pkg.version && <span>v{pkg.version}</span>}
            {pkg.author && <span>{pkg.author}</span>}
          </div>

          {/* Runtimes */}
          {runtimes.length > 0 && (
            <div className="space-y-1">
              <div className="flex items-center gap-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                <Zap className="w-3 h-3" />
                {t("plugin.runtimes", "Runtimes")}
              </div>
              <div className="space-y-0.5">
                {runtimes.map((rt) => (
                  <div key={rt.id} className="flex items-center gap-2 text-[10px] text-muted-foreground pl-1">
                    <span className="font-mono">{rt.id}</span>
                    <Badge variant="outline" className="text-[8px] px-1 py-0 h-3.5">
                      {rt.kind}
                    </Badge>
                    <span className="text-muted-foreground/60">
                      {TRIGGER_LABELS[rt.trigger.mode]
                        ? t(TRIGGER_LABELS[rt.trigger.mode].key, TRIGGER_LABELS[rt.trigger.mode].fallback)
                        : rt.trigger.mode}
                    </span>
                    {rt.providerTag && (
                      <span className="text-muted-foreground/60">
                        @ {rt.providerTag}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Tools */}
          {tools.length > 0 && (
            <div className="space-y-1">
              <div className="flex items-center gap-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                <Wrench className="w-3 h-3" />
                {t("plugin.tools", "Tools")}
                <span className="font-normal">({tools.length})</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {tools.map((tool) => (
                  <Badge key={tool.id} variant="outline" className="text-[9px] px-1.5 py-0 h-4 font-mono">
                    {tool.id}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Dependencies */}
          {requires.length > 0 && (
            <div className="space-y-1">
              <div className="flex items-center gap-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                <Link className="w-3 h-3" />
                {t("plugin.requires", "Requires")}
              </div>
              <div className="flex flex-wrap gap-1">
                {requires.map((dep) => (
                  <Badge key={dep} variant="secondary" className="text-[9px] px-1.5 py-0 h-4">
                    {dep}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PluginErrorItem({ error }: { error: PluginLoadError }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border border-destructive/40 bg-destructive/5 rounded-md overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center gap-2 px-2.5 py-2 text-left hover:bg-destructive/10 transition-colors"
        onClick={() => setExpanded((v) => !v)}
      >
        <ChevronRight
          className={`w-3 h-3 shrink-0 text-destructive transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
        />
        <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-destructive" />
        <span className="text-xs font-medium truncate flex-1 text-destructive">{error.pluginId}</span>
        <Badge variant="destructive" className="text-[9px] px-1.5 py-0 h-4 shrink-0">
          Error
        </Badge>
      </button>

      {expanded && (
        <div className="px-3 pb-2.5 pt-1 border-t border-destructive/20">
          <ul className="space-y-0.5">
            {error.errors.map((msg, i) => (
              <li key={i} className="text-[10px] text-destructive/80 font-mono">
                • {msg}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── V2 Session Plugin Item (collapsible, configurable, hot-swappable) ──

interface V2PluginItemProps {
  plugin: SessionPluginInfo;
  executing?: boolean;
  onToggle?: (pluginId: string, enable: boolean) => void;
}

const TRIGGER_TYPE_LABELS: Record<string, string> = {
  auto: "每轮",
  scheduled: "定时",
  manual: "手动",
  event: "事件",
  conditional: "条件",
  "error-retry": "重试",
};

const RUNTIME_TYPE_ICONS: Record<string, string> = {
  agent: "LLM",
  function: "Fn",
};

function V2PluginItem({ plugin, executing, onToggle }: V2PluginItemProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const displayName = typeof plugin.displayName === "string" ? plugin.displayName : plugin.id;
  const description = typeof plugin.description === "string" ? plugin.description : undefined;
  const isLocked = plugin.locked === true;
  const toggleDisabled = executing === true || isLocked;
  const allTools = [...(plugin.tools?.builtin ?? []), ...(plugin.tools?.local ?? [])];
  const configFields = Object.entries(plugin.config ?? {});
  const triggerLabel = plugin.trigger
    ? TRIGGER_TYPE_LABELS[plugin.trigger.type] ?? plugin.trigger.type
    : "auto";
  const runtimeLabel = RUNTIME_TYPE_ICONS[plugin.runtimeType ?? "agent"] ?? "LLM";

  return (
    <div className="border border-border rounded-md overflow-hidden">
      {/* Header */}
      <button
        type="button"
        className="w-full flex items-center gap-2 px-2.5 py-2 text-left hover:bg-muted/50 transition-colors"
        onClick={() => setExpanded((v) => !v)}
      >
        <ChevronRight
          className={`w-3 h-3 shrink-0 text-muted-foreground transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
        />
        <Puzzle className="w-3.5 h-3.5 shrink-0 text-primary/60" />
        <span className="text-xs font-medium truncate flex-1">{displayName}</span>
        {plugin.priority !== undefined && (
          <Badge variant="secondary" className="text-[9px] px-1.5 py-0 h-4 shrink-0">
            P{plugin.priority}
          </Badge>
        )}
        <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 shrink-0">
          {runtimeLabel}
        </Badge>
        {isLocked && (
          <span title={t("plugin.locked", "Core plugin — cannot be disabled")}>
            <Lock className="w-3 h-3 shrink-0 text-muted-foreground/50" />
          </span>
        )}
        {/* Toggle switch */}
        {onToggle && !isLocked && (
          <button
            type="button"
            role="switch"
            aria-checked={plugin.isActive}
            disabled={toggleDisabled}
            className={[
              "relative inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent",
              "transition-colors duration-200 ease-in-out focus-visible:outline-none focus-visible:ring-2",
              "focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              plugin.isActive ? "bg-primary" : "bg-input",
              toggleDisabled ? "opacity-50 cursor-not-allowed" : "",
            ].join(" ")}
            onClick={(e) => {
              e.stopPropagation();
              if (!toggleDisabled) onToggle(plugin.id, !plugin.isActive);
            }}
          >
            <span
              className={[
                "pointer-events-none inline-block h-3 w-3 rounded-full bg-background shadow-lg ring-0 transition duration-200 ease-in-out",
                plugin.isActive ? "translate-x-3" : "translate-x-0",
              ].join(" ")}
            />
          </button>
        )}
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-3 pb-2.5 pt-1 space-y-2 border-t border-border bg-muted/20">
          {/* Description */}
          {description && (
            <p className="text-[11px] text-muted-foreground leading-relaxed">{description}</p>
          )}

          {/* Meta badges */}
          <div className="flex flex-wrap gap-1">
            {plugin.model && (
              <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4">
                model: {plugin.model}
              </Badge>
            )}
            <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4">
              trigger: {triggerLabel}
              {plugin.trigger?.interval ? ` (${plugin.trigger.interval})` : ""}
              {plugin.trigger?.maxTriggerCount ? ` max:${plugin.trigger.maxTriggerCount}` : ""}
            </Badge>
            {plugin.pluginType && (
              <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4">
                {plugin.pluginType}
              </Badge>
            )}
          </div>

          {/* Tools */}
          {allTools.length > 0 && (
            <div className="space-y-1">
              <div className="flex items-center gap-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                <Wrench className="w-3 h-3" />
                Tools ({allTools.length})
              </div>
              <div className="flex flex-wrap gap-1">
                {allTools.map((tool) => (
                  <Badge key={tool} variant="outline" className="text-[9px] px-1.5 py-0 h-4 font-mono">
                    {tool}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Config fields */}
          {configFields.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                <Zap className="w-3 h-3" />
                {t("plugin.config", "Config")}
              </div>
              {configFields.map(([key, field]) => (
                <div key={key} className="space-y-0.5">
                  <label className="text-[10px] font-medium text-muted-foreground">
                    {field.label ?? key}
                    {field.description && (
                      <span className="ml-1 font-normal text-muted-foreground/60">— {field.description}</span>
                    )}
                  </label>
                  {field.type === "boolean" ? (
                    <div className="flex items-center gap-2">
                      <input type="checkbox" defaultChecked={field.default as boolean} className="h-3 w-3" />
                      <span className="text-[10px] text-muted-foreground">{String(field.default ?? false)}</span>
                    </div>
                  ) : field.options ? (
                    <select
                      defaultValue={String(field.default ?? "")}
                      className="w-full text-[10px] bg-background border border-border rounded px-1.5 py-1"
                    >
                      {field.options.map((opt) => (
                        <option key={opt} value={opt}>{opt}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type={field.type === "number" || field.type === "integer" ? "number" : "text"}
                      defaultValue={String(field.default ?? "")}
                      className="w-full text-[10px] bg-background border border-border rounded px-1.5 py-1"
                    />
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function PluginListPanel({
  packages,
  loadErrors = [],
  sessionPlugins,
  executing,
  onTogglePlugin,
}: PluginListPanelProps) {
  const { t } = useTranslation();

  const hasSessionPlugins = (sessionPlugins ?? []).length > 0;

  if (packages.length === 0 && loadErrors.length === 0 && !hasSessionPlugins) {
    return (
      <p className="text-xs text-muted-foreground italic">{t("session.noPluginsLoaded")}</p>
    );
  }

  // Build a lookup map from plugin id → session plugin info
  const sessionPluginMap = new Map<string, SessionPluginInfo>(
    (sessionPlugins ?? []).map((p) => [p.id, p]),
  );

  // V2 path: when packages (V1) are empty but sessionPlugins (V2) are available,
  // render V2 plugin items with full detail.
  const useV2View = packages.length === 0 && hasSessionPlugins;

  // Sort V2 plugins by priority
  const sortedPlugins = useV2View
    ? [...(sessionPlugins ?? [])].sort((a, b) => (a.priority ?? 500) - (b.priority ?? 500))
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
      {useV2View
        ? sortedPlugins.map((sp) => (
            <V2PluginItem
              key={sp.id}
              plugin={sp}
              executing={executing}
              onToggle={onTogglePlugin}
            />
          ))
        : packages.map((pkg) => (
            <PluginItem
              key={pkg.name}
              pkg={pkg}
              sessionPlugin={sessionPluginMap.get(pkg.name)}
              executing={executing}
              onToggle={onTogglePlugin}
            />
          ))
      }
    </div>
  );
}
