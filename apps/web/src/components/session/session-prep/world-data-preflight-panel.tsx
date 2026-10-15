import { AlertTriangle, Database, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import type * as api from "@/services/api.js";
import { WorldDataNoticeText } from "../world-data-notices.js";
import type { PrepSectionStatus } from "./types.js";

/** Kinds of import target the player can name; anything else is "other". */
const TARGET_KINDS = ["character", "lorebook", "media-index", "plugin-data"];

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
  // What will be imported, counted by kind: the targets themselves are
  // storage addresses the player has no use for.
  const targetCounts = new Map<string, number>();
  for (const target of result?.targets ?? []) {
    const kind = TARGET_KINDS.includes(target.kind) ? target.kind : "other";
    targetCounts.set(kind, (targetCounts.get(kind) ?? 0) + 1);
  }
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
                  defaultValue: "{{count}} item(s) will be imported",
                });

  return (
    <div className="space-y-2 border-t border-dashed border-border pt-3">
      <div className="flex items-center gap-2">
        <Database className="w-3.5 h-3.5 text-muted-foreground" />
        <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">
          {t("session.worldDataPreflight.title", "World Data")}
        </h4>
        <Badge
          variant={
            errors.length > 0 || status === "error"
              ? "destructive"
              : "secondary"
          }
          className="text-xs ml-auto"
        >
          {status === "loading" && (
            <Loader2 className="w-2.5 h-2.5 mr-1 animate-spin" />
          )}
          {badge}
        </Badge>
      </div>

      {status === "error" && (
        <div className="flex items-center justify-between gap-3 text-xs text-destructive">
          <span className="truncate">{error}</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-xs"
            onClick={onRetry}
          >
            {t("session.worldDataPreflight.retry", "Retry")}
          </Button>
        </div>
      )}

      {status === "success" && result?.imported === false && (
        <p className="text-xs text-muted-foreground">
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
              className="flex items-start gap-1.5 text-xs text-muted-foreground"
            >
              <AlertTriangle
                className={`w-3 h-3 mt-0.5 shrink-0 ${
                  item.level === "error" ? "text-destructive" : "text-amber-500"
                }`}
              />
              <span className="wrap-break-word">
                <WorldDataNoticeText notice={item} />
              </span>
            </div>
          ))}
        </div>
      )}

      {targetCounts.size > 0 && (
        <div className="flex flex-wrap gap-1">
          {[...targetCounts].map(([kind, count]) => (
            <Badge key={kind} variant="outline" className="text-xs">
              {t(`session.worldDataPreflight.kind.${kind}`, { count })}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
