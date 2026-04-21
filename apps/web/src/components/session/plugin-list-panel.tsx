import { useState, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Puzzle, Wrench, Zap, Link, AlertTriangle, Lock, Cpu } from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import { text } from "@/components/world/editor-helpers.js";
import * as api from "@/services/api.js";
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
  /** Current `runtimeModelOverrides` map from SessionRecord. */
  runtimeModelOverrides?: Record<string, string>;
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
  resolvedSlots?: ResolvedSlot[];
  sessionId?: string;
  runtimeModelOverrides?: Record<string, string>;
}

function PluginItem({ pkg, sessionPlugin, executing, onToggle, resolvedSlots, sessionId, runtimeModelOverrides }: PluginItemProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  // Model slot binding for agent runtimes. Key is the runtime's canonical id
  // (manifest `name`): single-runtime plugins use `pluginId`, multi-runtime
  // use `pluginId/runtimeName`. Server regex rejects any other shape (e.g.
  // `pluginId:runtimeId`), so the old colon form silently did nothing.
  const agentRuntimes = (pkg.runtimes ?? []).filter((rt) => rt.kind !== "function" && rt.providerTag);
  const primaryRuntime = agentRuntimes[0];
  const runtimeKey = primaryRuntime?.id ?? "";
  const initialSlot = useRef(runtimeKey ? (runtimeModelOverrides?.[runtimeKey] ?? "") : "");
  const [boundSlot, setBoundSlot] = useState<string>(initialSlot.current);

  const handleSlotChange = useCallback((newSlot: string) => {
    setBoundSlot(newSlot);
    if (!sessionId || !runtimeKey) return;
    const next: Record<string, string> = { ...(runtimeModelOverrides ?? {}) };
    if (newSlot) next[runtimeKey] = newSlot;
    else delete next[runtimeKey];
    void api.updateSession(sessionId, { runtimeModelOverrides: next }).catch(() => {
      // Non-fatal — user can retry by changing the slot again.
    });
  }, [sessionId, runtimeKey, runtimeModelOverrides]);

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
    <div className="border border-border rounded-md overflow-hidden paper:rounded-none paper:border-x-0 paper:border-t-0 paper:border-b paper:border-dashed paper:last:border-b-0">
      {/* Header — flex row with expand button and toggle as siblings (no nested buttons) */}
      <div className="flex items-center gap-0 hover:bg-muted/50 transition-colors paper:hover:bg-transparent">
        <button
          type="button"
          className="flex-1 flex items-center gap-2 px-2.5 py-2 text-left min-w-0 paper:px-1 paper:py-2"
          onClick={() => setExpanded((v) => !v)}
        >
          <ChevronRight
            className={`w-3 h-3 shrink-0 text-muted-foreground transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
          />
          <Puzzle className="w-3.5 h-3.5 shrink-0 text-primary/60 paper:hidden" />
          <span className="text-xs font-medium truncate flex-1 paper:font-mono paper:text-[11px] paper:font-normal paper:text-foreground">
            {displayName}
          </span>
          {mainRuntime && (
            <Badge variant="secondary" className="text-[9px] px-1.5 py-0 h-4 shrink-0 paper:bg-transparent paper:border paper:border-border paper:rounded-full paper:font-mono paper:tracking-[0.04em] paper:text-muted-foreground">
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
              "paper:h-3 paper:w-[22px] paper:border paper:border-[color:var(--color-border)]",
              isActive
                ? "bg-primary paper:bg-[color:var(--color-primary)] paper:border-transparent"
                : "bg-input paper:bg-[color:var(--color-muted)]",
              toggleDisabled ? "opacity-50 cursor-not-allowed" : "",
            ].join(" ")}
            onClick={() => { if (!toggleDisabled) onToggle(pkg.name, !isActive); }}
          >
            <span
              className={[
                "pointer-events-none inline-block h-3 w-3 rounded-full bg-background shadow-lg ring-0 transition duration-200 ease-in-out",
                "paper:h-2 paper:w-2 paper:shadow-none",
                isActive
                  ? "translate-x-3 paper:translate-x-[10px] paper:bg-[color:var(--color-primary-foreground)]"
                  : "translate-x-0 paper:translate-x-[1px] paper:bg-muted-foreground",
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

          {/* Model slot binding */}
          {primaryRuntime && resolvedSlots && resolvedSlots.length > 0 && (
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
                  {primaryRuntime.providerTag
                    ? `${t("plugin.defaultSlot", "default")}: ${primaryRuntime.providerTag}`
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
  runtimeModelOverrides?: Record<string, string>;
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

function SessionPluginItem({ plugin, executing, onToggle, resolvedSlots, sessionId, runtimeModelOverrides }: SessionPluginItemProps) {
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

  // Runtime binding: which model slot this plugin's runtime uses. `plugin.id`
  // is already the canonical runtime id (`pluginId` or `pluginId/runtimeName`)
  // accepted by the server regex; no prefix needed.
  const runtimeKey = plugin.id;
  const initialSlot = useRef(runtimeModelOverrides?.[runtimeKey] ?? "");
  const [boundSlot, setBoundSlot] = useState<string>(initialSlot.current);

  const handleSlotChange = useCallback((newSlot: string) => {
    setBoundSlot(newSlot);
    if (!sessionId) return;
    const next: Record<string, string> = { ...(runtimeModelOverrides ?? {}) };
    if (newSlot) next[runtimeKey] = newSlot;
    else delete next[runtimeKey];
    void api.updateSession(sessionId, { runtimeModelOverrides: next }).catch(
      () => {
        // Non-fatal — user can retry by changing the slot again.
      },
    );
  }, [sessionId, runtimeKey, runtimeModelOverrides]);

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
    <div className="border border-border rounded-md overflow-hidden paper:rounded-none paper:border-x-0 paper:border-t-0 paper:border-b paper:border-dashed paper:last:border-b-0">
      {/* Header — flex row with expand button and toggle as siblings (no nested buttons) */}
      <div className="flex items-center gap-0 hover:bg-muted/50 transition-colors paper:hover:bg-transparent">
        <button
          type="button"
          className="flex-1 flex items-center gap-2 px-2.5 py-2 text-left min-w-0 paper:px-1 paper:py-2"
          onClick={() => setExpanded((v) => !v)}
        >
          <ChevronRight
            className={`w-3 h-3 shrink-0 text-muted-foreground transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
          />
          <Puzzle className="w-3.5 h-3.5 shrink-0 text-primary/60 paper:hidden" />
          <span className="text-xs font-medium truncate flex-1 paper:font-mono paper:text-[11px] paper:font-normal paper:text-foreground">
            {displayName}
          </span>
          {plugin.priority !== undefined && (
            <Badge variant="secondary" className="text-[9px] px-1.5 py-0 h-4 shrink-0 paper:bg-transparent paper:border paper:border-border paper:rounded-full paper:font-mono paper:tracking-[0.04em] paper:text-muted-foreground">
              P{plugin.priority}
            </Badge>
          )}
          <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 shrink-0 paper:rounded-full paper:font-mono paper:tracking-[0.04em]">
            {runtimeLabel}
          </Badge>
          {isLocked && (
            <span title={t("plugin.locked", "Core plugin — cannot be disabled")}>
              <Lock className="w-3 h-3 shrink-0 text-muted-foreground/50" />
            </span>
          )}
        </button>
        {/* Inline model slot picker — visible without expanding. Stops click
            propagation so selecting a slot doesn't collapse/expand the row.
            Shows ALL resolved slots (not tag-filtered): an LLM runtime can
            legitimately be pointed at any configured slot regardless of that
            slot's `tag`, and filtering by tag === "text" used to hide the
            picker entirely for repos whose llm.toml only declares story /
            plugin / image slots. */}
        {plugin.runtimeType !== "function" && (
          resolvedSlots && resolvedSlots.length > 0 ? (
            <select
              value={boundSlot}
              onChange={(e) => handleSlotChange(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              disabled={executing}
              title={t("plugin.modelOverrideHint", "Override active — next turn will use this model")}
              aria-label={t("plugin.modelBinding", "Model")}
              className="shrink-0 mr-2 max-w-[140px] text-[9px] bg-background border border-border rounded px-1 py-0.5 disabled:opacity-50"
            >
              <option value="">
                {plugin.model ? `auto · ${plugin.model}` : "auto"}
              </option>
              {resolvedSlots.map((slot) => (
                <option key={slot.slotId} value={slot.slotId}>
                  {slot.slotId}{slot.serverModel ? ` · ${slot.serverModel}` : ""}
                </option>
              ))}
            </select>
          ) : (
            // Explicit hint when no slots are configured — previously the
            // picker silently vanished and users couldn't tell why.
            <span
              className="shrink-0 mr-2 text-[9px] text-muted-foreground italic"
              title={t("plugin.slotsMissing", "Configure model slots in llm.toml to override")}
            >
              no slots
            </span>
          )
        )}
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
              "paper:h-3 paper:w-[22px] paper:border paper:border-[color:var(--color-border)]",
              plugin.isActive
                ? "bg-primary paper:bg-[color:var(--color-primary)] paper:border-transparent"
                : "bg-input paper:bg-[color:var(--color-muted)]",
              toggleDisabled ? "opacity-50 cursor-not-allowed" : "",
            ].join(" ")}
            onClick={() => { if (!toggleDisabled) onToggle(plugin.id, !plugin.isActive); }}
          >
            <span
              className={[
                "pointer-events-none inline-block h-3 w-3 rounded-full bg-background shadow-lg ring-0 transition duration-200 ease-in-out",
                "paper:h-2 paper:w-2 paper:shadow-none",
                plugin.isActive
                  ? "translate-x-3 paper:translate-x-[10px] paper:bg-[color:var(--color-primary-foreground)]"
                  : "translate-x-0 paper:translate-x-[1px] paper:bg-muted-foreground",
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
  runtimeModelOverrides,
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
              runtimeModelOverrides={runtimeModelOverrides}
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
            />
          ))
      }
    </div>
  );
}
