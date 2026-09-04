import { useState } from "react";
import {
  AlertTriangle,
  ChevronRight,
  Lock,
  Puzzle,
  Wrench,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge.js";
import { formatSlotBindingLabel } from "@/hooks/use-slot-config.js";
import { resolveI18n } from "@/lib/catalog/helpers.js";
import { stageLabel } from "@/lib/stage-label.js";
import { useRuntimeModelSlotOverride } from "./runtime-model-slot-override.js";
import { SetupRecovery } from "./setup-recovery.js";
import { TRIGGER_TYPE_I18N, type SessionPluginItemProps } from "./types.js";
import { RuntimeCollectionFeatureBadges } from "../runtime-feature-badges.js";

export function SessionPluginItem({
  plugin,
  executing,
  onToggle,
  resolvedSlots,
  sessionId,
  runtimeModelOverrides,
  onRuntimeModelOverrideChange,
  setupRuntimes,
}: SessionPluginItemProps) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const primaryRuntime = plugin.runtimes[0];
  const runtimeKey = primaryRuntime?.id ?? plugin.id;
  const [boundSlot, handleSlotChange, overrideError] =
    useRuntimeModelSlotOverride({
      runtimeKey,
      sessionId,
      runtimeModelOverrides,
      onChange: onRuntimeModelOverrideChange,
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
            className="text-xs px-1.5 py-0 h-4 shrink-0"
          >
            {t("plugin.loadError", "Load Error")}
          </Badge>
        </button>
        {expanded && (
          <div className="px-3 pb-2.5 pt-1 border-t border-destructive/20">
            <p className="text-xs text-destructive/80 font-mono whitespace-pre-wrap break-all">
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
  const allTools = plugin.tools.map((tool) => tool.id);
  const triggerEntry =
    TRIGGER_TYPE_I18N[primaryRuntime?.trigger.type ?? "auto"];
  const triggerLabel = triggerEntry
    ? t(triggerEntry.key, triggerEntry.fallback)
    : (primaryRuntime?.trigger.type ?? "auto");
  const featureRuntimes = plugin.runtimes;

  return (
    <div className="border border-border rounded-(--radius-card) overflow-hidden">
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
          {stageLabel(primaryRuntime?.stage, t) && (
            <Badge
              variant="secondary"
              className="ui-chip text-xs px-1.5 py-0 h-4 shrink-0"
            >
              {stageLabel(primaryRuntime?.stage, t)}
            </Badge>
          )}
          <RuntimeCollectionFeatureBadges
            runtimes={featureRuntimes}
            display="summary"
          />
          {isLocked && (
            <span
              title={t("plugin.locked", "Core plugin — cannot be disabled")}
            >
              <Lock className="w-3 h-3 shrink-0 text-muted-foreground/50" />
            </span>
          )}
        </button>
        {primaryRuntime?.runtimeType !== "function" &&
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
              className="ui-input-shell min-w-0 shrink mr-2 max-w-35 text-xs bg-background border border-border px-1 py-0.5 disabled:opacity-50"
            >
              <option value="">
                {primaryRuntime?.model
                  ? t("plugin.autoWithModel", { model: primaryRuntime.model })
                  : t("plugin.autoSlot")}
              </option>
              {resolvedSlots.map((slot) => (
                <option key={slot.slotId} value={slot.slotId}>
                  {formatSlotBindingLabel(slot)}
                </option>
              ))}
            </select>
          ) : (
            <span
              className="shrink-0 mr-2 text-xs text-muted-foreground italic"
              title={t(
                "plugin.slotsMissing",
                "Configure model slots in llm.toml to override",
              )}
            >
              {t("plugin.noSlots")}
            </span>
          ))}
        {overrideError && (
          <span
            className="mr-2 text-xs text-destructive"
            role="alert"
            title={overrideError}
          >
            {t("plugin.modelOverrideFailed", "Save failed")}
          </span>
        )}
        {onToggle && !isLocked && (
          <button
            type="button"
            role="switch"
            aria-checked={plugin.active}
            aria-label={
              plugin.active
                ? t("plugin.disable", "Disable plugin")
                : t("plugin.enable", "Enable plugin")
            }
            disabled={toggleDisabled}
            className={[
              "relative inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent mr-2.5",
              "transition-colors duration-200 ease-in-out focus-visible:outline-none focus-visible:ring-2",
              "focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              plugin.active ? "bg-primary" : "bg-input",
              toggleDisabled ? "opacity-50 cursor-not-allowed" : "",
            ].join(" ")}
            onClick={() => {
              if (!toggleDisabled) onToggle(plugin.id, !plugin.active);
            }}
          >
            <span
              className={[
                "pointer-events-none inline-block h-3 w-3 rounded-full bg-background shadow-lg ring-0 transition duration-200 ease-in-out",
                plugin.active ? "translate-x-3" : "translate-x-0",
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
            <p className="text-xs text-muted-foreground leading-relaxed">
              {description}
            </p>
          )}

          <RuntimeCollectionFeatureBadges runtimes={featureRuntimes} />

          <div className="flex flex-wrap gap-1">
            {primaryRuntime?.model && (
              <Badge variant="outline" className="text-xs px-1.5 py-0 h-4">
                model: {primaryRuntime.model}
              </Badge>
            )}
            <Badge variant="outline" className="text-xs px-1.5 py-0 h-4">
              trigger: {triggerLabel}
              {primaryRuntime?.trigger.interval
                ? ` (${primaryRuntime.trigger.interval})`
                : ""}
              {primaryRuntime?.trigger.maxTriggerCount
                ? ` max:${primaryRuntime.trigger.maxTriggerCount}`
                : ""}
            </Badge>
            {plugin.pluginType && (
              <Badge variant="outline" className="text-xs px-1.5 py-0 h-4">
                {plugin.pluginType}
              </Badge>
            )}
          </div>

          {allTools.length > 0 && (
            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                <Wrench className="w-3 h-3" />
                Tools ({allTools.length})
              </div>
              <div className="flex flex-wrap gap-1">
                {allTools.map((tool) => (
                  <Badge
                    key={tool}
                    variant="outline"
                    className="text-xs px-1.5 py-0 h-4 font-mono"
                  >
                    {tool}
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
