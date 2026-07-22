import { useState } from "react";
import {
  ChevronRight,
  Cpu,
  Link,
  Lock,
  Puzzle,
  Wrench,
  Zap,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge.js";
import { text } from "@/components/world/editor-helpers.js";
import { stageLabel } from "@/lib/stage-label.js";
import { formatSlotLabel } from "@/hooks/use-slot-config.js";
import { useRuntimeModelSlotOverride } from "./runtime-model-slot-override.js";
import { SetupRecovery } from "./setup-recovery.js";
import { TRIGGER_LABELS, type PluginItemProps } from "./types.js";

export function PluginItem({
  pkg,
  sessionPlugin,
  executing,
  onToggle,
  resolvedSlots,
  sessionId,
  runtimeModelOverrides,
  setupRuntimes,
}: PluginItemProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const agentRuntimes = (pkg.runtimes ?? []).filter(
    (rt) => rt.kind !== "function" && rt.model,
  );
  const primaryRuntime = agentRuntimes[0];
  const runtimeKey = primaryRuntime?.id ?? "";
  const [boundSlot, handleSlotChange] = useRuntimeModelSlotOverride({
    runtimeKey,
    sessionId,
    runtimeModelOverrides,
  });

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
    <div className="border border-border rounded-[var(--radius-card)] overflow-hidden">
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
          <span className="text-xs font-medium truncate flex-1">
            {displayName}
          </span>
          {sessionPlugin?.source && (
            <Badge
              variant="outline"
              className={[
                "ui-chip text-[9px] px-1.5 py-0 h-4 shrink-0",
                sessionPlugin.source === "builtin"
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : sessionPlugin.source === "official"
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                    : "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
              ].join(" ")}
              title={t(
                `plugin.source.${sessionPlugin.source}.tooltip`,
                sessionPlugin.source === "builtin"
                  ? "Builtin core plugin shipped with Covel"
                  : sessionPlugin.source === "official"
                    ? "Official plugin curated by Covel"
                    : "Third-party plugin installed under ~/.covel/plugins",
              )}
            >
              {t(
                `plugin.source.${sessionPlugin.source}.label`,
                sessionPlugin.source === "builtin"
                  ? "Core"
                  : sessionPlugin.source === "official"
                    ? "Official"
                    : "Third-party",
              )}
            </Badge>
          )}
          {mainRuntime && stageLabel(mainRuntime.stage, t) && (
            <Badge
              variant="secondary"
              className="ui-chip text-[9px] px-1.5 py-0 h-4 shrink-0"
            >
              {stageLabel(mainRuntime.stage, t)}
            </Badge>
          )}
          {isLocked && (
            <span
              title={t("plugin.locked", "Core plugin — cannot be disabled")}
            >
              <Lock className="w-3 h-3 shrink-0 text-muted-foreground/50" />
            </span>
          )}
        </button>
        {hasSessionScope && onToggle && !isLocked && (
          <button
            type="button"
            role="switch"
            aria-checked={isActive}
            aria-label={
              isActive
                ? t("plugin.disable", "Disable plugin")
                : t("plugin.enable", "Enable plugin")
            }
            disabled={toggleDisabled}
            className={[
              "relative inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent mr-2.5",
              "transition-colors duration-200 ease-in-out focus-visible:outline-none focus-visible:ring-2",
              "focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              isActive ? "bg-primary" : "bg-input",
              toggleDisabled ? "opacity-50 cursor-not-allowed" : "",
            ].join(" ")}
            onClick={() => {
              if (!toggleDisabled) onToggle(pkg.name, !isActive);
            }}
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

      <SetupRecovery
        pluginId={pkg.name}
        sessionId={sessionId}
        setupRuntimes={setupRuntimes}
      />

      {primaryRuntime && (
        <div className="px-2.5 pb-1 -mt-0.5 flex items-center gap-1 text-[9px] text-muted-foreground/80">
          <Cpu className="w-2.5 h-2.5" />
          {resolvedSlots && resolvedSlots.length > 0 ? (
            (() => {
              const activeSlot = boundSlot
                ? (resolvedSlots.find((s) => s.slotId === boundSlot) ??
                  resolvedSlots[0])
                : resolvedSlots[0];
              const label = formatSlotLabel(activeSlot);
              return (
                <span
                  className="truncate"
                  title={t(
                    "plugin.modelBindingSource",
                    "Model binding — edit in Session Prep",
                  )}
                >
                  {label ?? activeSlot?.slotId ?? "—"}
                </span>
              );
            })()
          ) : (
            <span className="italic">
              {t(
                "plugin.modelBindingFallback",
                "Model binding: see Session Prep",
              )}
            </span>
          )}
        </div>
      )}

      {expanded && (
        <div className="px-3 pb-2.5 pt-0.5 space-y-2 border-t border-border bg-muted/20">
          {description && (
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              {description}
            </p>
          )}

          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
            {pkg.version && <span>v{pkg.version}</span>}
            {pkg.author && <span>{pkg.author}</span>}
          </div>

          {runtimes.length > 0 && (
            <div className="space-y-1">
              <div className="flex items-center gap-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                <Zap className="w-3 h-3" />
                {t("plugin.runtimes", "Runtimes")}
              </div>
              <div className="space-y-0.5">
                {runtimes.map((rt) => (
                  <div
                    key={rt.id}
                    className="flex items-center gap-2 text-[10px] text-muted-foreground pl-1"
                  >
                    <span className="font-mono">{rt.id}</span>
                    <Badge
                      variant="outline"
                      className="text-[8px] px-1 py-0 h-3.5"
                    >
                      {rt.kind}
                    </Badge>
                    <span className="text-muted-foreground/60">
                      {TRIGGER_LABELS[rt.trigger.type]
                        ? t(
                            TRIGGER_LABELS[rt.trigger.type].key,
                            TRIGGER_LABELS[rt.trigger.type].fallback,
                          )
                        : rt.trigger.type}
                    </span>
                    {rt.model && (
                      <span className="text-muted-foreground/60">
                        @ {rt.model}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {tools.length > 0 && (
            <div className="space-y-1">
              <div className="flex items-center gap-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                <Wrench className="w-3 h-3" />
                {t("plugin.tools", "Tools")}
                <span className="font-normal">({tools.length})</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {tools.map((tool) => (
                  <Badge
                    key={tool.id}
                    variant="outline"
                    className="text-[9px] px-1.5 py-0 h-4 font-mono"
                  >
                    {tool.id}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {requires.length > 0 && (
            <div className="space-y-1">
              <div className="flex items-center gap-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                <Link className="w-3 h-3" />
                {t("plugin.requires", "Requires")}
              </div>
              <div className="flex flex-wrap gap-1">
                {requires.map((dep) => (
                  <Badge
                    key={dep}
                    variant="secondary"
                    className="text-[9px] px-1.5 py-0 h-4"
                  >
                    {dep}
                  </Badge>
                ))}
              </div>
            </div>
          )}

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
                  {primaryRuntime.model
                    ? `${t("plugin.defaultSlot", "default")}: ${primaryRuntime.model}`
                    : t("plugin.autoSlot", "auto (system default)")}
                </option>
                {resolvedSlots
                  .filter((s) => s.tag === "text")
                  .map((slot) => (
                    <option key={slot.slotId} value={slot.slotId}>
                      {slot.slotId.toUpperCase()} —{" "}
                      {slot.serverModel ?? slot.presetId}
                    </option>
                  ))}
              </select>
              {boundSlot && (
                <p className="text-[9px] text-muted-foreground">
                  {t(
                    "plugin.modelOverrideHint",
                    "Override active — next turn will use this model",
                  )}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
