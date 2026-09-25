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
import { resolveI18n } from "@/lib/catalog/helpers.js";
import { RuntimeStageBadges } from "../runtime-stage-badges.js";
import { RuntimeModelBindings } from "./runtime-model-bindings.js";
import { SetupRecovery } from "./setup-recovery.js";
import type { SessionPluginItemProps } from "./types.js";
import {
  RuntimeCollectionFeatureBadges,
  RuntimeFeatureBadges,
} from "../runtime-feature-badges.js";

export function SessionPluginItem({
  plugin,
  executing,
  advanced = false,
  onToggle,
  resolvedSlots,
  sessionId,
  runtimeModelOverrides,
  onRuntimeModelOverrideChange,
  setupRuntimes,
}: SessionPluginItemProps) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState(false);

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
          {isLocked && (
            <span
              title={t("plugin.locked", "Core plugin — cannot be disabled")}
            >
              <Lock className="w-3 h-3 shrink-0 text-muted-foreground/50" />
            </span>
          )}
        </button>
        {onToggle && !isLocked && (
          <button
            type="button"
            role="switch"
            aria-checked={plugin.active}
            aria-label={`${displayName}: ${
              plugin.active
                ? t("plugin.disable", "Disable plugin")
                : t("plugin.enable", "Enable plugin")
            }`}
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

      {plugin.approvalRequired && (
        <p
          role="status"
          className="px-2.5 pb-2 text-xs text-amber-700 dark:text-amber-300"
        >
          {t("plugin.approval.required")}
        </p>
      )}

      {advanced && (
        <div className="flex flex-wrap items-center gap-1 px-2.5 pb-2">
          <RuntimeStageBadges runtimes={plugin.runtimes} />
          <RuntimeCollectionFeatureBadges
            runtimes={featureRuntimes}
            display="summary"
          />
        </div>
      )}

      {advanced && (
        <RuntimeModelBindings
          runtimes={plugin.runtimes}
          resolvedSlots={resolvedSlots}
          sessionId={sessionId}
          executing={executing}
          runtimeModelOverrides={runtimeModelOverrides}
          onChange={onRuntimeModelOverrideChange}
        />
      )}

      {expanded && (
        <div className="px-3 pb-2.5 pt-1 space-y-2 border-t border-border bg-muted/20">
          {description && (
            <p className="text-xs text-muted-foreground leading-relaxed">
              {description}
            </p>
          )}

          {advanced && (
            <>
              <div className="space-y-2">
                {plugin.runtimes.map((runtime) => (
                  <div key={runtime.id} className="space-y-1">
                    <p className="break-all font-mono text-xs">{runtime.id}</p>
                    <RuntimeStageBadges runtimes={[runtime]} />
                    <RuntimeFeatureBadges runtime={runtime} />
                    {runtime.trigger.interval && (
                      <p className="break-all font-mono text-xs">
                        interval: {runtime.trigger.interval}
                      </p>
                    )}
                    {runtime.trigger.maxTriggerCount !== undefined && (
                      <p className="font-mono text-xs">
                        max: {runtime.trigger.maxTriggerCount}
                      </p>
                    )}
                  </div>
                ))}
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
            </>
          )}
        </div>
      )}
    </div>
  );
}
