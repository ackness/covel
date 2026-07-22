import { useState } from "react";
import {
  AlertTriangle,
  ChevronRight,
  Lock,
  Puzzle,
  Wrench,
  Zap,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge.js";
import { resolveI18n } from "@/lib/catalog/helpers.js";
import { useRuntimeModelSlotOverride } from "./runtime-model-slot-override.js";
import { SetupRecovery } from "./setup-recovery.js";
import {
  RUNTIME_TYPE_ICONS,
  TRIGGER_TYPE_I18N,
  type SessionPluginItemProps,
} from "./types.js";

export function SessionPluginItem({
  plugin,
  executing,
  onToggle,
  resolvedSlots,
  sessionId,
  runtimeModelOverrides,
  setupRuntimes,
}: SessionPluginItemProps) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const runtimeKey = plugin.id;
  const [boundSlot, handleSlotChange] = useRuntimeModelSlotOverride({
    runtimeKey,
    sessionId,
    runtimeModelOverrides,
  });

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
          <span className="text-xs font-medium truncate flex-1 text-destructive">
            {plugin.id}
          </span>
          <Badge
            variant="destructive"
            className="text-[9px] px-1.5 py-0 h-4 shrink-0"
          >
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

  // Resolve i18n displayName / description to the UI locale (both arrive as
  // I18nText `{ zh, en }` from the manifest). Falls back to the plugin id for
  // the name and hides the description when absent.
  const displayName =
    resolveI18n(plugin.displayName, i18n.language) || plugin.id;
  const description =
    resolveI18n(plugin.description, i18n.language) || undefined;
  const isLocked = plugin.locked === true;
  const toggleDisabled = executing === true || isLocked;
  const allTools = [
    ...(plugin.tools?.builtin ?? []),
    ...(plugin.tools?.local ?? []),
  ];
  const configFields = Object.entries(plugin.config ?? {});
  const triggerEntry = TRIGGER_TYPE_I18N[plugin.trigger?.type ?? "auto"];
  const triggerLabel = triggerEntry
    ? t(triggerEntry.key, triggerEntry.fallback)
    : (plugin.trigger?.type ?? "auto");
  const runtimeLabel =
    RUNTIME_TYPE_ICONS[plugin.runtimeType ?? "agent"] ?? "LLM";

  return (
    <div className="border border-border rounded-[var(--radius-card)] overflow-hidden">
      <div className="flex flex-wrap items-center gap-y-1 hover:bg-muted/50 transition-colors">
        <button
          type="button"
          className="flex-1 flex items-center gap-2 px-2.5 py-2 text-left min-w-0"
          onClick={() => setExpanded((v) => !v)}
        >
          <ChevronRight
            className={`w-3 h-3 shrink-0 text-muted-foreground transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
          />
          <Puzzle className="w-3.5 h-3.5 shrink-0 text-primary/60" />
          <span className="text-xs font-medium truncate flex-1 min-w-0">
            {displayName}
          </span>
          {plugin.priority !== undefined && (
            <Badge
              variant="secondary"
              className="ui-chip text-[9px] px-1.5 py-0 h-4 shrink-0"
            >
              P{plugin.priority}
            </Badge>
          )}
          <Badge
            variant="outline"
            className="ui-chip text-[9px] px-1 py-0 h-4 shrink-0"
          >
            {runtimeLabel}
          </Badge>
          {isLocked && (
            <span
              title={t("plugin.locked", "Core plugin — cannot be disabled")}
            >
              <Lock className="w-3 h-3 shrink-0 text-muted-foreground/50" />
            </span>
          )}
        </button>
        {plugin.runtimeType !== "function" &&
          (resolvedSlots && resolvedSlots.length > 0 ? (
            <select
              value={boundSlot}
              onChange={(e) => handleSlotChange(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              disabled={executing}
              title={t(
                "plugin.modelOverrideHint",
                "Override active — next turn will use this model",
              )}
              aria-label={t("plugin.modelBinding", "Model")}
              className="ui-input-shell min-w-0 flex-shrink mr-2 max-w-[140px] text-[9px] bg-background border border-border px-1 py-0.5 disabled:opacity-50"
            >
              <option value="">
                {plugin.model ? `auto · ${plugin.model}` : "auto"}
              </option>
              {resolvedSlots.map((slot) => (
                <option key={slot.slotId} value={slot.slotId}>
                  {slot.slotId}
                  {slot.serverModel ? ` · ${slot.serverModel}` : ""}
                </option>
              ))}
            </select>
          ) : (
            <span
              className="shrink-0 mr-2 text-[9px] text-muted-foreground italic"
              title={t(
                "plugin.slotsMissing",
                "Configure model slots in llm.toml to override",
              )}
            >
              no slots
            </span>
          ))}
        {onToggle && !isLocked && (
          <button
            type="button"
            role="switch"
            aria-checked={plugin.isActive}
            aria-label={
              plugin.isActive
                ? t("plugin.disable", "Disable plugin")
                : t("plugin.enable", "Enable plugin")
            }
            disabled={toggleDisabled}
            className={[
              "relative inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent mr-2.5",
              "transition-colors duration-200 ease-in-out focus-visible:outline-none focus-visible:ring-2",
              "focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              plugin.isActive ? "bg-primary" : "bg-input",
              toggleDisabled ? "opacity-50 cursor-not-allowed" : "",
            ].join(" ")}
            onClick={() => {
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
        <SetupRecovery
          pluginId={plugin.id}
          sessionId={sessionId}
          setupRuntimes={setupRuntimes}
        />
      </div>

      {expanded && (
        <div className="px-3 pb-2.5 pt-1 space-y-2 border-t border-border bg-muted/20">
          {description && (
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              {description}
            </p>
          )}

          <div className="flex flex-wrap gap-1">
            {plugin.model && (
              <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4">
                model: {plugin.model}
              </Badge>
            )}
            <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4">
              trigger: {triggerLabel}
              {plugin.trigger?.interval ? ` (${plugin.trigger.interval})` : ""}
              {plugin.trigger?.maxTriggerCount
                ? ` max:${plugin.trigger.maxTriggerCount}`
                : ""}
            </Badge>
            {plugin.pluginType && (
              <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4">
                {plugin.pluginType}
              </Badge>
            )}
          </div>

          {allTools.length > 0 && (
            <div className="space-y-1">
              <div className="flex items-center gap-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                <Wrench className="w-3 h-3" />
                Tools ({allTools.length})
              </div>
              <div className="flex flex-wrap gap-1">
                {allTools.map((tool) => (
                  <Badge
                    key={tool}
                    variant="outline"
                    className="text-[9px] px-1.5 py-0 h-4 font-mono"
                  >
                    {tool}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {configFields.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                <Zap className="w-3 h-3" />
                {t("plugin.config", "Config")}
              </div>
              {configFields.map(([key, field]) => (
                <div
                  key={key}
                  className="flex items-center justify-between gap-2 text-[10px]"
                >
                  <span className="text-muted-foreground">
                    {field.label ?? key}
                    {field.description && (
                      <span className="ml-1 text-muted-foreground/50">
                        — {field.description}
                      </span>
                    )}
                  </span>
                  <Badge
                    variant="outline"
                    className="text-[9px] px-1.5 py-0 h-4 font-mono shrink-0"
                  >
                    {field.options
                      ? String(field.default ?? field.options[0])
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
