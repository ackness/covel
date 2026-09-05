import {
  Loader2,
  CheckCircle2,
  XCircle,
  Zap,
  Wrench,
  RotateCw,
  SkipForward,
  Clock,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ExecutionStep } from "@/stores/session-store.js";

export interface RuntimeStatus {
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

export function deriveStatuses(
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

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return s < 60
    ? `${s.toFixed(1)}s`
    : `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

export const I18N_SENTINEL_PREFIX = "__i18n:";
const I18N_SENTINEL_SUFFIX = "__";

export function resolveI18nSentinel(
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

export function RuntimeChip({
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
