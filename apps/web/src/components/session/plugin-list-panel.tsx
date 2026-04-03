import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Puzzle, Wrench, Zap, Link } from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import { text } from "@/components/world/editor-helpers.js";
import type { PackageSummary } from "@/services/api.js";

interface PluginListPanelProps {
  packages: PackageSummary[];
}

const TRIGGER_LABELS: Record<string, { key: string; fallback: string }> = {
  always: { key: "plugin.triggerAlways", fallback: "Always" },
  interval: { key: "plugin.triggerInterval", fallback: "Interval" },
  manual: { key: "plugin.triggerManual", fallback: "Manual" },
  event: { key: "plugin.triggerEvent", fallback: "Event" },
};

function PluginItem({ pkg }: { pkg: PackageSummary }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const displayName = text(pkg.displayName) || pkg.name;
  const description = text(pkg.description);
  const runtimes = pkg.runtimes ?? [];
  const tools = pkg.tools ?? [];
  const requires = pkg.requires ?? [];
  const mainRuntime = runtimes[0];

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
                    {rt.providerBinding && (
                      <span className="text-muted-foreground/60">
                        @ {rt.providerBinding}
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

export function PluginListPanel({ packages }: PluginListPanelProps) {
  const { t } = useTranslation();

  if (packages.length === 0) {
    return (
      <p className="text-xs text-muted-foreground italic">{t("session.noPluginsLoaded")}</p>
    );
  }

  return (
    <div className="space-y-1.5">
      {packages.map((pkg) => (
        <PluginItem key={pkg.name} pkg={pkg} />
      ))}
    </div>
  );
}
