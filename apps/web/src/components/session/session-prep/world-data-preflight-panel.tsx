import { AlertTriangle, Database, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import type * as api from "@/services/api.js";
import type { PrepSectionStatus } from "./types.js";

interface WorldDataPreflightPanelProps {
  result: api.WorldDataPreflightResponse | null;
  status: PrepSectionStatus;
  error: string | null;
  onRetry: () => void;
}

export function WorldDataPreflightPanel({
  result,
  status,
  error,
  onRetry,
}: WorldDataPreflightPanelProps) {
  const { t } = useTranslation();
  const diagnostics = result?.diagnostics ?? [];
  const errors = diagnostics.filter((item) => item.level === "error");
  const warnings = diagnostics.filter((item) => item.level === "warning");
  const visibleDiagnostics = diagnostics
    .filter((item) => item.level !== "info")
    .slice(0, 3);
  const visibleTargets = result?.targets.slice(0, 3) ?? [];
  const moreTargets = Math.max((result?.targets.length ?? 0) - 3, 0);
  const badge =
    status === "loading"
      ? t("session.worldDataPreflight.loading", "Checking")
      : status === "error"
        ? t("session.worldDataPreflight.failed", "Check failed")
        : result?.imported === false
          ? t("session.worldDataPreflight.empty", "No import plan")
          : errors.length > 0
            ? t("session.worldDataPreflight.errors", {
                count: errors.length,
                defaultValue: "{{count}} error(s)",
              })
            : warnings.length > 0
              ? t("session.worldDataPreflight.warnings", {
                  count: warnings.length,
                  defaultValue: "{{count}} warning(s)",
                })
              : t("session.worldDataPreflight.ready", {
                  count: result?.planned ?? 0,
                  defaultValue: "{{count}} item(s)",
                });

  return (
    <div className="space-y-2 border-t border-dashed border-border pt-3">
      <div className="flex items-center gap-2">
        <Database className="w-3.5 h-3.5 text-muted-foreground" />
        <h4 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">
          {t("session.worldDataPreflight.title", "World Data")}
        </h4>
        <Badge
          variant={
            errors.length > 0 || status === "error"
              ? "destructive"
              : "secondary"
          }
          className="text-[9px] ml-auto"
        >
          {status === "loading" && (
            <Loader2 className="w-2.5 h-2.5 mr-1 animate-spin" />
          )}
          {badge}
        </Badge>
      </div>

      {status === "error" && (
        <div className="flex items-center justify-between gap-3 text-[11px] text-destructive">
          <span className="truncate">{error}</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-[10px]"
            onClick={onRetry}
          >
            {t("session.worldDataPreflight.retry", "Retry")}
          </Button>
        </div>
      )}

      {status === "success" && result?.imported === false && (
        <p className="text-[11px] text-muted-foreground">
          {t(
            "session.worldDataPreflight.emptyDetail",
            "This world has no worldData import plan.",
          )}
        </p>
      )}

      {visibleDiagnostics.length > 0 && (
        <div className="space-y-1">
          {visibleDiagnostics.map((item, index) => (
            <div
              key={`${item.sourceId ?? "world"}-${index}`}
              className="flex items-start gap-1.5 text-[11px] text-muted-foreground"
            >
              <AlertTriangle
                className={`w-3 h-3 mt-0.5 shrink-0 ${
                  item.level === "error" ? "text-destructive" : "text-amber-500"
                }`}
              />
              <span className="wrap-break-word">
                {item.sourceId ? `${item.sourceId}: ` : ""}
                {item.message}
              </span>
            </div>
          ))}
        </div>
      )}

      {visibleTargets.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {visibleTargets.map((target, index) => (
            <Badge
              key={`${target.target}-${target.key ?? index}`}
              variant="outline"
              className="max-w-full text-[9px] font-mono"
              title={`${target.kind} ${target.target}${target.key ? `:${target.key}` : ""}`}
            >
              <span className="truncate max-w-55">
                {target.target}
                {target.key ? `:${target.key}` : ""}
              </span>
            </Badge>
          ))}
          {moreTargets > 0 && (
            <Badge variant="outline" className="text-[9px]">
              {t("session.worldDataPreflight.moreTargets", {
                count: moreTargets,
                defaultValue: "{{count}} more",
              })}
            </Badge>
          )}
        </div>
      )}
    </div>
  );
}
