import {
  Loader2,
  CheckCircle2,
  XCircle,
  Zap,
  Wrench,
  ChevronDown,
  ChevronUp,
  RotateCw,
  SkipForward,
  Clock,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { resolveI18nText } from "@covel/shared";
import type { ExecutionStep } from "@/stores/session-store.js";
import type { PluginSummary } from "@/services/api.js";
import { ActionableErrorNotice } from "@/components/shared/actionable-error-notice.js";

interface RuntimeStatus {
  runtimeId: string;
  pluginId: string;
  label: string;
  status:
    | "running"
    | "llm"
    | "tool"
    | "deferred"
    | "completed"
    | "failed"
    | "skipped"
    | "suspended";
  detail?: string;
  /** Qualified tool name when status is "tool" (e.g. "init-wizard:emit-character-form"). */
  toolName?: string;
  /** Duration in milliseconds (only set when completed or failed). */
  durationMs?: number;
  detached?: boolean;
  jobState?: string;
  progress?: number;
}

function deriveStatuses(
  steps: ExecutionStep[],
  runtimeLabels: Record<string, string>,
): RuntimeStatus[] {
  // ExecutionStep is now a status-aggregation row (one per runtime per turn),
  // so derive is mostly a projection. The old event-stream logic (llm.calling
  // / tool.calling transient states) is gone — the server doesn't emit those
  // through /api/actions today, and if it ever does they'll arrive as
  // separate UPSERT_EXECUTION_STEP patches carrying status:"llm"|"tool".
  // Label resolution. Multi-runtime plugins (e.g. `npc-graph/rag-retriever`
  // and `npc-graph/extractor`) must render distinct chips, so we show the
  // runtime suffix after the plugin display name when runtimeId !== pluginId.
  // Prefer an exact runtime-id override, then pluginDisplayName + "/" + suffix,
  // then the raw fallback.
  const runtimeLabel = (step: ExecutionStep): string => {
    if (runtimeLabels[step.runtimeId]) return runtimeLabels[step.runtimeId];
    const pluginLabel = runtimeLabels[step.pluginId] ?? step.pluginId;
    if (step.runtimeId && step.runtimeId !== step.pluginId) {
      const suffix = step.runtimeId.startsWith(`${step.pluginId}/`)
        ? step.runtimeId.slice(step.pluginId.length + 1)
        : step.runtimeId;
      return `${pluginLabel} / ${suffix}`;
    }
    return step.label ?? pluginLabel ?? step.runtimeId;
  };

  return steps.map((step) => ({
    runtimeId: step.runtimeId,
    pluginId: step.pluginId,
    label: runtimeLabel(step),
    status: step.status,
    detail: step.detail,
    toolName: step.toolName,
    durationMs: step.durationMs,
    detached: step.detached,
    jobState: step.jobState,
    progress: step.progress,
  }));
}

function StatusIcon({ status }: { status: RuntimeStatus["status"] }) {
  switch (status) {
    case "running":
      return <Loader2 className="w-3 h-3 animate-spin text-blue-500" />;
    case "llm":
      return <Zap className="w-3 h-3 animate-pulse text-amber-500" />;
    case "tool":
      return <Wrench className="w-3 h-3 animate-pulse text-violet-500" />;
    case "deferred":
      return <Clock className="w-3 h-3 animate-pulse text-sky-500" />;
    case "completed":
      return <CheckCircle2 className="w-3 h-3 text-green-500" />;
    case "failed":
      return <XCircle className="w-3 h-3 text-destructive" />;
    case "skipped":
      return <SkipForward className="w-3 h-3 text-muted-foreground" />;
    case "suspended":
      return <Clock className="w-3 h-3 text-amber-500" />;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return s < 60
    ? `${s.toFixed(1)}s`
    : `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

const I18N_SENTINEL_PREFIX = "__i18n:";
const I18N_SENTINEL_SUFFIX = "__";

function resolveI18nSentinel(
  value: string | undefined,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string | undefined {
  if (!value) return value;
  if (!value.startsWith(I18N_SENTINEL_PREFIX)) return value;
  const body = value.slice(I18N_SENTINEL_PREFIX.length);
  const key = body.endsWith(I18N_SENTINEL_SUFFIX)
    ? body.slice(0, -I18N_SENTINEL_SUFFIX.length)
    : body;
  return t(key) as string;
}

function RuntimeChip({
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
  const isActive =
    rt.status === "running" ||
    rt.status === "llm" ||
    rt.status === "tool" ||
    rt.status === "deferred";

  return (
    <span
      className={
        "group inline-flex max-w-full flex-wrap items-center gap-1 px-2 py-0.5 text-[11px] border transition-colors " +
        "ui-chip " +
        (rt.status === "deferred"
          ? "border-sky-500/35 bg-sky-500/5 text-foreground"
          : isActive
            ? "border-primary/30 bg-primary/5 text-foreground"
            : rt.status === "failed"
              ? "border-destructive/30 bg-destructive/5 text-destructive"
              : rt.status === "skipped"
                ? "border-border/40 bg-muted/20 text-muted-foreground/70 italic"
                : rt.status === "suspended"
                  ? "border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-400"
                  : "border-border/50 bg-muted/30 text-muted-foreground")
      }
    >
      <StatusIcon status={rt.status} />
      <span className="font-medium truncate max-w-30 ui-chip-name">
        {rt.label}
      </span>
      {rt.detached && (
        <span className="rounded-sm border border-sky-500/25 bg-sky-500/10 px-1 text-[9px] leading-3 text-sky-700 dark:text-sky-300">
          {rt.status === "deferred"
            ? t("session.backgroundRunning")
            : t("session.backgroundTask")}
        </span>
      )}
      {rt.status === "deferred" && rt.progress != null && (
        <span className="text-[10px] tabular-nums text-sky-700 dark:text-sky-300">
          {Math.max(0, Math.min(100, Math.round(rt.progress)))}%
        </span>
      )}
      {rt.status === "tool" && rt.toolName && (
        <span className="text-[10px] text-muted-foreground truncate max-w-35 font-mono">
          {rt.toolName}
        </span>
      )}
      {rt.detail === "[cached]" && (
        <span className="text-[10px] text-muted-foreground/60 italic">
          cached
        </span>
      )}
      {rt.durationMs != null && (
        <span className="text-[10px] text-muted-foreground/70 tabular-nums">
          {formatDuration(rt.durationMs)}
        </span>
      )}
      {canRetry && onRetry && !(rt.status === "failed" && rt.detail) && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRetry(rt.runtimeId);
          }}
          className="opacity-0 group-hover:opacity-100 transition-opacity ml-0.5 p-0.5 hover:text-primary"
          title={retryFromLabel}
        >
          <RotateCw className="w-2.5 h-2.5" />
        </button>
      )}
    </span>
  );
}

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
  const resolvedDetail = resolveI18nSentinel(rt.detail, t);
  if (!resolvedDetail) return null;

  const isIncomplete = rt.detail?.startsWith(
    `${I18N_SENTINEL_PREFIX}session.reasonConnectionClosed`,
  );

  return (
    <div
      role="alert"
      className="w-full min-w-0 max-w-2xl overflow-hidden rounded-(--radius-control) border border-destructive/35 bg-destructive/5"
    >
      <div className="flex min-w-0 items-start gap-2 px-3 py-2">
        <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[11px] font-medium text-destructive">
              {rt.label}
            </span>
            {rt.durationMs != null && (
              <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
                {formatDuration(rt.durationMs)}
              </span>
            )}
          </div>
          <div className="mt-1">
            <ActionableErrorNotice
              error={resolvedDetail}
              kind={isIncomplete ? "incomplete" : undefined}
              layout="panel"
            />
          </div>
        </div>
        {canRetry && onRetry && (
          <button
            type="button"
            onClick={() => onRetry(rt.runtimeId)}
            className="shrink-0 rounded-(--radius-control) p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
            title={retryFromLabel}
            aria-label={retryFromLabel}
          >
            <RotateCw className="h-3 w-3" />
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
  onRetryAll,
}: {
  steps: ExecutionStep[];
  executing: boolean;
  plugins?: PluginSummary[];
  onRetryRuntime?: (runtimeId: string, sourceTurnId?: string) => void;
  onRetryAll?: () => void;
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
        const isLatest = group.turnId === latestTurnId;
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
        const allDone = !executing || !isLatest ? !active : false;
        const canRetry = allDone && isLatest && !!onRetryRuntime;
        const failures = statuses.filter(
          (runtime) => runtime.status === "failed" && runtime.detail,
        );
        const isCollapsed =
          foldOverrides[group.turnId] ?? !(executing && isLatest);
        const turnNumber = groupIdx + 1;

        return (
          <div
            key={group.turnId}
            className={`space-y-1 ${!isLatest ? "opacity-50 hover:opacity-80 transition-opacity" : ""}`}
          >
            {/* Turn header */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => toggleTurn(group.turnId, isCollapsed)}
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
                {activeBackgroundCount > 0 && (
                  <span className="rounded-full border border-sky-500/25 bg-sky-500/10 px-1.5 py-0.5 text-[9px] font-medium normal-case tracking-normal text-sky-700 dark:text-sky-300">
                    {t("session.backgroundCount", {
                      count: activeBackgroundCount,
                    })}
                  </span>
                )}
              </button>
              {isLatest && onRetryAll && allDone && (
                <button
                  onClick={onRetryAll}
                  className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-primary transition-colors"
                  title={t("session.retryAllTitle")}
                >
                  <RotateCw className="w-3 h-3" />
                  <span>{t("session.retryAll")}</span>
                </button>
              )}
            </div>

            {/* Chips row */}
            {!isCollapsed && (
              <>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {statuses.map((rt) => (
                    <RuntimeChip
                      key={rt.runtimeId}
                      rt={rt}
                      canRetry={canRetry}
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
                {failures.length > 0 && (
                  <div className="mt-1.5 flex min-w-0 flex-col gap-1.5">
                    {failures.map((rt) => (
                      <RuntimeFailureNotice
                        key={rt.runtimeId}
                        rt={rt}
                        canRetry={canRetry}
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
              </>
            )}

            {/* Active detail line (latest turn only) */}
            {isLatest && active && (
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground animate-pulse">
                <Loader2 className="w-3 h-3 animate-spin shrink-0" />
                <span className="truncate">
                  {active.label}
                  {active.status === "llm" && ` — ${t("session.statusLlm")}`}
                  {active.status === "tool" &&
                    active.toolName &&
                    ` — ${active.toolName}`}
                  {active.status === "running" &&
                    ` — ${t("session.statusPreparing")}`}
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
