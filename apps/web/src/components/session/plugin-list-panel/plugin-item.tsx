import { useState } from "react";
import { ChevronRight, Link, Lock, Puzzle, Wrench, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge.js";
import { text } from "@/components/world/editor-helpers.js";
import { RuntimeStageBadges } from "../runtime-stage-badges.js";
import { RuntimeModelBindings } from "./runtime-model-bindings.js";
import { SetupRecovery } from "./setup-recovery.js";
import type { PluginItemProps } from "./types.js";
import {
  RuntimeCollectionFeatureBadges,
  RuntimeFeatureBadges,
} from "../runtime-feature-badges.js";

export function PluginItem({
  pkg,
  sessionPlugin,
  executing,
  advanced = false,
  onToggle,
  resolvedSlots,
  sessionId,
  runtimeModelOverrides,
  onRuntimeModelOverrideChange,
  setupRuntimes,
}: PluginItemProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const displayName = text(pkg.displayName) || pkg.id;
  const description = text(pkg.description);
  const runtimes = pkg.runtimes ?? [];
  const tools = pkg.tools ?? [];
  const requires = pkg.relations?.requires ?? [];

  const hasSessionScope = sessionPlugin !== undefined;
  const isActive = sessionPlugin?.active ?? true;
  const isLocked = sessionPlugin?.locked === true;
  const toggleDisabled = executing === true || isLocked;

  return (
    <div className="border border-border rounded-(--radius-card) overflow-hidden">
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
                "ui-chip text-xs px-1.5 py-0 h-4 shrink-0",
                sessionPlugin.source === "builtin"
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
              ].join(" ")}
              title={t(
                `plugin.source.${sessionPlugin.source}.tooltip`,
                sessionPlugin.source === "builtin"
                  ? "Builtin core plugin shipped with Covel"
                  : "Third-party plugin installed under ~/.covel/plugins",
              )}
            >
              {t(
                `plugin.source.${sessionPlugin.source}.label`,
                sessionPlugin.source === "builtin" ? "Core" : "Third-party",
              )}
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
            aria-label={`${displayName}: ${
              isActive
                ? t("plugin.disable", "Disable plugin")
                : t("plugin.enable", "Enable plugin")
            }`}
            disabled={toggleDisabled}
            className={[
              "relative inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent mr-2.5",
              "transition-colors duration-200 ease-in-out focus-visible:outline-none focus-visible:ring-2",
              "focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              isActive ? "bg-primary" : "bg-input",
              toggleDisabled ? "opacity-50 cursor-not-allowed" : "",
            ].join(" ")}
            onClick={() => {
              if (!toggleDisabled) onToggle(pkg.id, !isActive);
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

      {advanced && (
        <div className="flex flex-wrap items-center gap-1 px-2.5 pb-2">
          <RuntimeStageBadges runtimes={runtimes} />
          <RuntimeCollectionFeatureBadges
            runtimes={runtimes}
            display="summary"
          />
        </div>
      )}

      <SetupRecovery
        pluginId={pkg.id}
        sessionId={sessionId}
        setupRuntimes={setupRuntimes}
      />

      {advanced && (
        <RuntimeModelBindings
          runtimes={runtimes}
          resolvedSlots={resolvedSlots}
          sessionId={sessionId}
          executing={executing}
          runtimeModelOverrides={runtimeModelOverrides}
          onChange={onRuntimeModelOverrideChange}
        />
      )}

      {expanded && (
        <div className="px-3 pb-2.5 pt-0.5 space-y-2 border-t border-border bg-muted/20">
          {description && (
            <p className="text-xs text-muted-foreground leading-relaxed">
              {description}
            </p>
          )}

          {advanced && (
            <>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                {pkg.version && <span>v{pkg.version}</span>}
              </div>

              {advanced && runtimes.length > 0 && (
                <div className="space-y-1">
                  <div className="flex items-center gap-1 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    <Zap className="w-3 h-3" />
                    {t("plugin.runtimes", "Runtimes")}
                  </div>
                  <div className="space-y-0.5">
                    {runtimes.map((rt) => (
                      <div
                        key={rt.id}
                        className="flex min-w-0 flex-wrap items-center gap-2 pl-1 text-xs text-muted-foreground"
                      >
                        <span className="font-mono">{rt.id}</span>
                        <RuntimeFeatureBadges runtime={rt} />
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
                  <div className="flex items-center gap-1 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    <Wrench className="w-3 h-3" />
                    {t("plugin.tools", "Tools")}
                    <span className="font-normal">({tools.length})</span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {tools.map((tool) => (
                      <Badge
                        key={tool.id}
                        variant="outline"
                        className="text-xs px-1.5 py-0 h-4 font-mono"
                      >
                        {tool.id}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {requires.length > 0 && (
                <div className="space-y-1">
                  <div className="flex items-center gap-1 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    <Link className="w-3 h-3" />
                    {t("plugin.requires", "Requires")}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {requires.map((dep) => (
                      <Badge
                        key={dep}
                        variant="secondary"
                        className="text-xs px-1.5 py-0 h-4"
                      >
                        {dep}
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
