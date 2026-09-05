import {
  Loader2,
  XCircle,
  ChevronDown,
  ChevronUp,
  RotateCw,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { resolveI18nText } from "@covel/shared";
import type { ExecutionStep } from "@/stores/session-store.js";
import type { PluginSummary } from "@/services/api.js";
import { ActionableErrorNotice } from "@/components/shared/actionable-error-notice.js";

import {
  formatDuration,
  deriveStatuses,
  RuntimeChip,
  resolveI18nSentinel,
  I18N_SENTINEL_PREFIX,
  type RuntimeStatus,
} from "./execution-runtime-status.js";

function RuntimeFailureNotice({
  rt,
  canRetry,
  onRetry,
  retryFromLabel,
}: {
  rt: RuntimeStatus;
  canRetry?: boolean;
  onRetry?: (runtimeId: string) => void;
  retryFromLabel: string;
}) {
  const { t } = useTranslation();
  const resolvedDetail =
    resolveI18nSentinel(rt.detail, t) ??
    t("session.runtimeFailedDetail", {
      defaultValue:
        "This task did not complete. Retry it or inspect its trace.",
    });

  const isIncomplete = rt.detail?.startsWith(
    `${I18N_SENTINEL_PREFIX}session.reasonConnectionClosed`,
  );
  const isInterrupted = rt.detail?.startsWith(
    `${I18N_SENTINEL_PREFIX}session.reasonInterrupted`,
  );

  return (
    <div
      role="alert"
      className={`w-full min-w-0 overflow-hidden rounded-(--radius-control) border p-3 ${isInterrupted ? "border-amber-500/30 bg-amber-500/5" : "border-destructive/35 bg-destructive/5"}`}
    >
      <div className="flex min-w-0 flex-wrap items-start gap-2">
        <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-xs font-medium text-foreground">
              {rt.label}
            </span>
            {rt.durationMs != null && (
              <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
                {formatDuration(rt.durationMs)}
              </span>
            )}
          </div>
          <div className="mt-1">
            {rt.detail?.startsWith(I18N_SENTINEL_PREFIX) && !isIncomplete ? (
              <p className="text-xs leading-relaxed text-muted-foreground">
                {resolvedDetail}
              </p>
            ) : (
              <ActionableErrorNotice
                error={resolvedDetail}
                kind={isIncomplete ? "incomplete" : undefined}
                layout="panel"
              />
            )}
          </div>
        </div>
        {canRetry && onRetry && (
          <button
            type="button"
            onClick={() => onRetry(rt.runtimeId)}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-(--radius-control) border border-border px-3 py-2 text-xs text-foreground transition-colors hover:bg-muted"
            title={retryFromLabel}
            aria-label={`${t("session.retryTask")}: ${rt.label}`}
          >
            <RotateCw className="h-3 w-3" />
            {t("session.retryTask")}
          </button>
        )}
      </div>
    </div>
  );
}

/** Group steps by turnId, preserving insertion order. */
function groupStepsByTurn(
  steps: ExecutionStep[],
): Array<{ turnId: string; steps: ExecutionStep[] }> {
  const order: string[] = [];
  const map = new Map<string, ExecutionStep[]>();
  for (const step of steps) {
    const tid = step.turnId ?? "unknown";
    if (!map.has(tid)) {
      order.push(tid);
      map.set(tid, []);
    }
    map.get(tid)!.push(step);
  }
  return order.map((tid) => ({ turnId: tid, steps: map.get(tid)! }));
}

export function ExecutionTimeline({
  steps,
  executing,
  plugins = [],
  onRetryRuntime,
  isLatestTurn = true,
  turnNumberStart = 1,
  canRetryTasks = true,
}: {
  steps: ExecutionStep[];
  executing: boolean;
  plugins?: PluginSummary[];
  onRetryRuntime?: (
    runtimeId: string | readonly string[],
    sourceTurnId?: string,
  ) => void;
  isLatestTurn?: boolean;
  turnNumberStart?: number;
  canRetryTasks?: boolean;
}) {
  const { i18n, t } = useTranslation();
  // Per-turn explicit fold override. Without one, the runtime chips only show
  // while the turn is actually running (useful progress); once it settles they
  // fold away so per-runtime ids and timings don't sit in the story flow.
  const [foldOverrides, setFoldOverrides] = useState<Record<string, boolean>>(
    {},
  );

  // Build label map from plugin manifests (pluginId → display name)
  const RUNTIME_LABELS: Record<string, string> = {};
  for (const plugin of plugins) {
    const name = resolveI18nText(plugin.displayName, i18n.language);
    if (name) RUNTIME_LABELS[plugin.id] = name;
  }

  const turnGroups = groupStepsByTurn(steps);

  if (turnGroups.length === 0 && executing) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        <span>{t("session.startingUp")}</span>
      </div>
    );
  }

  if (turnGroups.length === 0) return null;

  const latestTurnId = turnGroups[turnGroups.length - 1]?.turnId;

  const toggleTurn = (turnId: string, collapsed: boolean) => {
    setFoldOverrides((prev) => ({ ...prev, [turnId]: !collapsed }));
  };

  return (
    <div className="space-y-2 py-1">
      {turnGroups.map((group, groupIdx) => {
        const statuses = deriveStatuses(group.steps, RUNTIME_LABELS);
        const isLatest = isLatestTurn && group.turnId === latestTurnId;
        const active = statuses.find(
          (r) =>
            r.status === "running" ||
            r.status === "llm" ||
            r.status === "tool" ||
            r.status === "deferred",
        );
        const activeBackgroundCount = statuses.filter(
          (runtime) => runtime.status === "deferred",
        ).length;
        const activeForeground = statuses.some(
          (runtime) =>
            !runtime.detached &&
            ["running", "llm", "tool"].includes(runtime.status),
        );
        const allDone = (!executing || !isLatest) && !activeForeground;
        const canRetry =
          allDone && isLatest && canRetryTasks && !!onRetryRuntime;
        const failures = statuses.filter(
          (runtime) => runtime.status === "failed",
        );
        const retryableFailures = failures.filter(
          (runtime) =>
            !runtime.detached &&
            !runtime.detail?.startsWith(
              `${I18N_SENTINEL_PREFIX}session.reasonInterrupted`,
            ) &&
            !runtime.detail?.startsWith(
              `${I18N_SENTINEL_PREFIX}session.reasonConnectionClosed`,
            ),
        );
        // The action contract bounds one atomic retry to twenty targets.
        const retryBatch = retryableFailures.slice(0, 20);
        const isCollapsed =
          foldOverrides[group.turnId] ?? !(executing && isLatest);
        const turnNumber = groupIdx + turnNumberStart;

        return (
          <div
            key={group.turnId}
            data-testid="execution-turn"
            data-turn-id={group.turnId}
            data-historical={!isLatest}
            className={`space-y-1 ${!isLatest && failures.length === 0 ? "opacity-70 hover:opacity-100 transition-opacity" : ""}`}
          >
            {/* Turn header */}
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => toggleTurn(group.turnId, isCollapsed)}
                aria-expanded={!isCollapsed}
                className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
              >
                {isCollapsed ? (
                  <ChevronDown className="w-3 h-3" />
                ) : (
                  <ChevronUp className="w-3 h-3" />
                )}
                <span className="uppercase tracking-wider font-mono">
                  {t("session.executionSummary", { count: statuses.length })}
                </span>
                <span className="text-[9px] text-muted-foreground/50 font-mono">
                  #{turnNumber}
                </span>
                {!isLatest && <span>{t("session.executionHistory")}</span>}
                {failures.length > 0 && (
                  <span className="text-destructive font-medium normal-case tracking-normal">
                    {t("session.executionFailures", {
                      count: failures.length,
                      defaultValue: "{{count}} failed",
                    })}
                  </span>
                )}
                {activeBackgroundCount > 0 && (
                  <span className="rounded-full border border-sky-500/25 bg-sky-500/10 px-1.5 py-0.5 text-[9px] font-medium normal-case tracking-normal text-sky-700 dark:text-sky-300">
                    {t("session.backgroundCount", {
                      count: activeBackgroundCount,
                    })}
                  </span>
                )}
              </button>
              {canRetry && retryableFailures.length > 1 && (
                <button
                  type="button"
                  onClick={() =>
                    onRetryRuntime?.(
                      retryBatch.map((rt) => rt.runtimeId),
                      group.turnId,
                    )
                  }
                  className="inline-flex items-center gap-1.5 rounded-(--radius-control) border border-primary/40 bg-primary/10 px-3 py-2 text-xs font-medium text-foreground hover:bg-primary/20"
                >
                  <RotateCw className="h-3 w-3" />
                  {t(
                    retryableFailures.length > retryBatch.length
                      ? "session.retryFailedBatch"
                      : "session.retryFailedTasks",
                    {
                      count: retryBatch.length,
                    },
                  )}
                </button>
              )}
            </div>

            {isLatest &&
              allDone &&
              canRetryTasks &&
              failures.length > 0 &&
              statuses.some((runtime) => runtime.status === "completed") && (
                <p className="text-sm text-destructive">
                  {t("session.partialCompletion", {
                    defaultValue:
                      "Some updates failed. Review the affected tasks below.",
                  })}
                </p>
              )}
            {canRetry && retryableFailures.length > 0 && (
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t("session.retryScopeHint")}
                {retryableFailures.length > retryBatch.length &&
                  ` ${t("session.retryBatchLimit", { count: retryBatch.length })}`}
              </p>
            )}

            {/* Chips row */}
            {!isCollapsed && (
              <>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {statuses.map((rt) => (
                    <RuntimeChip
                      key={rt.runtimeId}
                      rt={rt}
                      canRetry={canRetry && retryableFailures.includes(rt)}
                      // Carry the chip's turn id so the retry replays THIS
                      // turn's recorded upstream outputs (server-side seeding).
                      onRetry={
                        onRetryRuntime
                          ? (rid) => onRetryRuntime(rid, group.turnId)
                          : undefined
                      }
                      retryFromLabel={t("session.retryFrom", {
                        label: rt.label,
                      })}
                    />
                  ))}
                </div>
              </>
            )}

            {failures.length > 0 && (isLatest || !isCollapsed) && (
              <div className="mt-1.5 flex min-w-0 flex-col gap-1.5">
                {failures.map((rt) => (
                  <RuntimeFailureNotice
                    key={rt.runtimeId}
                    rt={rt}
                    canRetry={canRetry && retryableFailures.includes(rt)}
                    onRetry={
                      onRetryRuntime
                        ? (rid) => onRetryRuntime(rid, group.turnId)
                        : undefined
                    }
                    retryFromLabel={t("session.retryFrom", {
                      label: rt.label,
                    })}
                  />
                ))}
              </div>
            )}

            {/* Active detail line (latest turn only) */}
            {(isLatest || active?.detached) && active && (
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground animate-pulse">
                <Loader2 className="w-3 h-3 animate-spin shrink-0" />
                <span className="truncate">
                  {active.label}
                  {active.status === "llm" && ` — ${t("session.statusLlm")}`}
                  {active.status === "tool" &&
                    active.toolName &&
                    ` — ${active.toolName}`}
                  {active.status === "running" &&
                    ` — ${active.detail?.startsWith(I18N_SENTINEL_PREFIX) ? resolveI18nSentinel(active.detail, t) : t("session.statusPreparing")}`}
                  ...
                </span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
