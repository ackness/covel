import { useState, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Puzzle, Wrench, Zap, Link, AlertTriangle, Lock, Cpu } from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import { text } from "@/components/world/editor-helpers.js";
import { getRuntimeBindings, setRuntimeBindings } from "@/services/api.js";
import type { PackageSummary, PluginLoadError, SessionPluginInfo } from "@/services/api.js";
import type { ResolvedSlot } from "@/hooks/use-slot-config.js";

interface PluginListPanelProps {
  packages: PackageSummary[];
  loadErrors?: PluginLoadError[];
  /** Session-scoped plugin info with live isActive state. */
  sessionPlugins?: SessionPluginInfo[];
  /** Whether a turn is currently executing (disables toggles mid-turn). */
  executing?: boolean;
  /** Called when the user flips the enable/disable switch. */
  onTogglePlugin?: (pluginId: string, enable: boolean) => void;
  /** Available model slots for runtime binding. */
  resolvedSlots?: ResolvedSlot[];
  /** Current session ID (for persisting runtime bindings). */
  sessionId?: string;
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
      {/* Header — flex row with expand button and toggle as siblings (no nested buttons) */}
      <div className="flex items-center gap-0 hover:bg-muted/50 transition-colors">
        <button
          type="button"
          className="flex-1 flex items-center gap-2 px-2.5 py-2 text-left min-w-0"
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
        </button>
        {/* Toggle switch — sibling, not nested */}
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
              "relative inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent mr-2.5",
              "transition-colors duration-200 ease-in-out focus-visible:outline-none focus-visible:ring-2",
              "focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              isActive ? "bg-primary" : "bg-input",
              toggleDisabled ? "opacity-50 cursor-not-allowed" : "",
            ].join(" ")}
            onClick={() => { if (!toggleDisabled) onToggle(pkg.name, !isActive); }}
          >
            <span
              className={[
                "pointer-events-none inline-block h-3 w-3 rounded-full bg-background shadow-lg ring-0 transition duration-200 ease-in-out",
                isActive ? "translate-x-3" : "translate-x-0",
              ].join(" ")}
            />
          </button>
        )}
      </div>

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

// ── Session Plugin Item (collapsible, configurable, hot-swappable) ──

interface SessionPluginItemProps {
  plugin: SessionPluginInfo;
  executing?: boolean;
  onToggle?: (pluginId: string, enable: boolean) => void;
  resolvedSlots?: ResolvedSlot[];
  sessionId?: string;
}

const TRIGGER_TYPE_I18N: Record<string, { key: string; fallback: string }> = {
  auto: { key: "plugin.triggerAuto", fallback: "Every turn" },
  scheduled: { key: "plugin.triggerScheduled", fallback: "Scheduled" },
  manual: { key: "plugin.triggerManual", fallback: "Manual" },
  event: { key: "plugin.triggerEvent", fallback: "Event" },
  conditional: { key: "plugin.triggerConditional", fallback: "Conditional" },
  "error-retry": { key: "plugin.triggerErrorRetry", fallback: "Error retry" },
};

const RUNTIME_TYPE_ICONS: Record<string, string> = {
  agent: "LLM",
  function: "Fn",
};

function SessionPluginItem({ plugin, executing, onToggle, resolvedSlots, sessionId }: SessionPluginItemProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  // Plugin failed to load — render error state
  if (plugin.status === "error") {
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
          <span className="text-xs font-medium truncate flex-1 text-destructive">{plugin.id}</span>
          <Badge variant="destructive" className="text-[9px] px-1.5 py-0 h-4 shrink-0">
            {t("plugin.loadError", "Load Error")}
          </Badge>
        </button>
        {expanded && (
          <div className="px-3 pb-2.5 pt-1 border-t border-destructive/20">
            <p className="text-[10px] text-destructive/80 font-mono whitespace-pre-wrap break-all">
              {plugin.error ?? t("plugin.unknownError", "Unknown error")}
            </p>
          </div>
        )}
      </div>
    );
  }

  // Runtime binding: which model slot this plugin uses
  const runtimeKey = plugin.id;
  const initialSlot = useRef(sessionId ? (getRuntimeBindings(sessionId)[runtimeKey] ?? "") : "");
  const [boundSlot, setBoundSlot] = useState<string>(initialSlot.current);

  const handleSlotChange = useCallback((newSlot: string) => {
    setBoundSlot(newSlot);
    if (!sessionId) return;
    const bindings = getRuntimeBindings(sessionId);
    if (newSlot) {
      bindings[runtimeKey] = newSlot;
    } else {
      delete bindings[runtimeKey];
    }
    setRuntimeBindings(sessionId, bindings);
  }, [sessionId, runtimeKey]);

  const displayName = typeof plugin.displayName === "string" ? plugin.displayName : plugin.id;
  const description = typeof plugin.description === "string" ? plugin.description : undefined;
  const isLocked = plugin.locked === true;
  const toggleDisabled = executing === true || isLocked;
  const allTools = [...(plugin.tools?.builtin ?? []), ...(plugin.tools?.local ?? [])];
  const configFields = Object.entries(plugin.config ?? {});
  const triggerEntry = TRIGGER_TYPE_I18N[plugin.trigger?.type ?? "auto"];
  const triggerLabel = triggerEntry ? t(triggerEntry.key, triggerEntry.fallback) : (plugin.trigger?.type ?? "auto");
  const runtimeLabel = RUNTIME_TYPE_ICONS[plugin.runtimeType ?? "agent"] ?? "LLM";

  return (
    <div className="border border-border rounded-md overflow-hidden">
      {/* Header — flex row with expand button and toggle as siblings (no nested buttons) */}
      <div className="flex items-center gap-0 hover:bg-muted/50 transition-colors">
        <button
          type="button"
          className="flex-1 flex items-center gap-2 px-2.5 py-2 text-left min-w-0"
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
        </button>
        {/* Toggle switch — sibling, not nested */}
        {onToggle && !isLocked && (
          <button
            type="button"
            role="switch"
            aria-checked={plugin.isActive}
            aria-label={plugin.isActive ? t("plugin.disable", "Disable plugin") : t("plugin.enable", "Enable plugin")}
            disabled={toggleDisabled}
            className={[
              "relative inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent mr-2.5",
              "transition-colors duration-200 ease-in-out focus-visible:outline-none focus-visible:ring-2",
              "focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              plugin.isActive ? "bg-primary" : "bg-input",
              toggleDisabled ? "opacity-50 cursor-not-allowed" : "",
            ].join(" ")}
            onClick={() => { if (!toggleDisabled) onToggle(plugin.id, !plugin.isActive); }}
          >
            <span
              className={[
                "pointer-events-none inline-block h-3 w-3 rounded-full bg-background shadow-lg ring-0 transition duration-200 ease-in-out",
                plugin.isActive ? "translate-x-3" : "translate-x-0",
              ].join(" ")}
            />
          </button>
        )}
      </div>

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

          {/* Model slot binding */}
          {plugin.runtimeType !== "function" && resolvedSlots && resolvedSlots.length > 0 && (
            <div className="space-y-1">
              <div className="flex items-center gap-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                <Cpu className="w-3 h-3" />
                {t("plugin.modelBinding", "Model")}
              </div>
              <select
                value={boundSlot}
                onChange={(e) => handleSlotChange(e.target.value)}
                disabled={executing}
                className="w-full text-[10px] bg-background border border-border rounded px-1.5 py-1 disabled:opacity-50"
              >
                <option value="">
                  {plugin.model
                    ? `${t("plugin.defaultSlot", "default")}: ${plugin.model}`
                    : t("plugin.autoSlot", "auto (system default)")}
                </option>
                {resolvedSlots.filter(s => s.tag === "text").map((slot) => (
                  <option key={slot.slotId} value={slot.slotId}>
                    {slot.slotId.toUpperCase()} — {slot.serverModel ?? slot.presetId}
                  </option>
                ))}
              </select>
              {boundSlot && (
                <p className="text-[9px] text-muted-foreground">
                  {t("plugin.modelOverrideHint", "Override active — next turn will use this model")}
                </p>
              )}
            </div>
          )}

          {/* Config fields */}
          {/* Config schema (read-only display — editing requires PATCH /api/plugins/:id/config) */}
          {configFields.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                <Zap className="w-3 h-3" />
                {t("plugin.config", "Config")}
              </div>
              {configFields.map(([key, field]) => (
                <div key={key} className="flex items-center justify-between gap-2 text-[10px]">
                  <span className="text-muted-foreground">
                    {field.label ?? key}
                    {field.description && (
                      <span className="ml-1 text-muted-foreground/50">— {field.description}</span>
                    )}
                  </span>
                  <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 font-mono shrink-0">
                    {field.options
                      ? (String(field.default ?? field.options[0]))
                      : field.type === "boolean"
                        ? String(field.default ?? false)
                        : String(field.default ?? "—")}
                  </Badge>
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
  resolvedSlots,
  sessionId,
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

  // When session plugins are available, render detailed plugin items.
  // Fall back to package-level summary view otherwise.
  const useDetailView = packages.length === 0 && hasSessionPlugins;

  // Sort plugins by priority
  const sortedPlugins = useDetailView
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
      {useDetailView
        ? sortedPlugins.map((sp) => (
            <SessionPluginItem
              key={sp.id}
              plugin={sp}
              executing={executing}
              onToggle={onTogglePlugin}
              resolvedSlots={resolvedSlots}
              sessionId={sessionId}
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
