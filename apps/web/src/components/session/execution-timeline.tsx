import { Loader2, CheckCircle2, XCircle, Zap, Wrench, ChevronDown, ChevronUp, RotateCw } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ExecutionStep } from "@/stores/session-store.js";
import type { PackageSummary } from "@/services/api.js";

interface RuntimeStatus {
  runtimeId: string;
  pluginId: string;
  label: string;
  status: "running" | "llm" | "tool" | "completed" | "failed";
  detail?: string;
  /** Qualified tool name when status is "tool" (e.g. "core-init-wizard:emit-character-form"). */
  toolName?: string;
  /** Duration in milliseconds (only set when completed or failed). */
  durationMs?: number;
}

function deriveStatuses(
  steps: ExecutionStep[],
  runtimeLabels: Record<string, string>,
): RuntimeStatus[] {
  const map = new Map<string, RuntimeStatus>();
  const startTimes = new Map<string, number>();

  const runtimeLabel = (step: ExecutionStep): string => {
    if (runtimeLabels[step.runtimeId]) return runtimeLabels[step.runtimeId];
    if (runtimeLabels[step.pluginId]) return runtimeLabels[step.pluginId];
    return step.label ?? step.pluginId ?? step.runtimeId;
  };

  for (const step of steps) {
    const existing = map.get(step.runtimeId);

    switch (step.type) {
      case "runtime.started":
        map.set(step.runtimeId, {
          runtimeId: step.runtimeId,
          pluginId: step.pluginId,
          label: runtimeLabel(step),
          status: "running",
          durationMs: undefined,
        });
        startTimes.set(step.runtimeId, new Date(step.timestamp).getTime());
        break;
      case "llm.calling":
        if (existing) {
          map.set(step.runtimeId, { ...existing, status: "llm", detail: step.detail });
        }
        break;
      case "tool.calling":
        if (existing) {
          // step.label is the qualified tool ID (e.g. "core-init-wizard:emit-character-form")
          map.set(step.runtimeId, { ...existing, status: "tool", toolName: step.label, detail: step.detail });
        }
        break;
      case "tool.completed":
        if (existing) {
          map.set(step.runtimeId, { ...existing, status: "running", toolName: undefined, detail: undefined });
        }
        break;
      case "runtime.completed": {
        if (existing) {
          const start = startTimes.get(step.runtimeId);
          const dur = start ? new Date(step.timestamp).getTime() - start : undefined;
          map.set(step.runtimeId, { ...existing, status: "completed", detail: undefined, durationMs: dur });
        }
        break;
      }
      case "runtime.failed": {
        if (existing) {
          const start = startTimes.get(step.runtimeId);
          const dur = start ? new Date(step.timestamp).getTime() - start : undefined;
          map.set(step.runtimeId, { ...existing, status: "failed", detail: step.detail, durationMs: dur });
        }
        break;
      }
    }
  }

  return Array.from(map.values());
}

function StatusIcon({ status }: { status: RuntimeStatus["status"] }) {
  switch (status) {
    case "running":
      return <Loader2 className="w-3 h-3 animate-spin text-blue-500" />;
    case "llm":
      return <Zap className="w-3 h-3 animate-pulse text-amber-500" />;
    case "tool":
      return <Wrench className="w-3 h-3 animate-pulse text-violet-500" />;
    case "completed":
      return <CheckCircle2 className="w-3 h-3 text-green-500" />;
    case "failed":
      return <XCircle className="w-3 h-3 text-destructive" />;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
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
  const isActive = rt.status === "running" || rt.status === "llm" || rt.status === "tool";

  return (
    <span
      className={`group inline-flex items-center gap-1 px-2 py-0.5 text-[11px] border transition-colors ${
        isActive
          ? "border-primary/30 bg-primary/5 text-foreground"
          : rt.status === "failed"
            ? "border-destructive/30 bg-destructive/5 text-destructive"
            : "border-border/50 bg-muted/30 text-muted-foreground"
      }`}
    >
      <StatusIcon status={rt.status} />
      <span className="font-medium truncate max-w-[120px]">{rt.label}</span>
      {rt.status === "tool" && rt.toolName && (
        <span className="text-[10px] text-muted-foreground truncate max-w-[140px] font-mono">
          {rt.toolName}
        </span>
      )}
      {rt.detail === "[cached]" && (
        <span className="text-[10px] text-muted-foreground/60 italic">cached</span>
      )}
      {rt.durationMs != null && (
        <span className="text-[10px] text-muted-foreground/70 tabular-nums">
          {formatDuration(rt.durationMs)}
        </span>
      )}
      {canRetry && onRetry && (
        <button
          onClick={(e) => { e.stopPropagation(); onRetry(rt.runtimeId); }}
          className="opacity-0 group-hover:opacity-100 transition-opacity ml-0.5 p-0.5 hover:text-primary"
          title={retryFromLabel}
        >
          <RotateCw className="w-2.5 h-2.5" />
        </button>
      )}
    </span>
  );
}

function resolveDisplayName(
  displayName: string | Record<string, string> | undefined,
  locale: string,
): string | undefined {
  if (!displayName) return undefined;
  if (typeof displayName === "string") return displayName;
  return displayName[locale] ?? displayName["en-US"] ?? Object.values(displayName)[0];
}

export function ExecutionTimeline({
  steps,
  executing,
  packages = [],
  onRetryRuntime,
  onRetryAll,
}: {
  steps: ExecutionStep[];
  executing: boolean;
  packages?: PackageSummary[];
  onRetryRuntime?: (runtimeId: string) => void;
  onRetryAll?: () => void;
}) {
  const { i18n, t } = useTranslation();
  const [collapsed, setCollapsed] = useState(false);

  // Build label map from plugin manifests (pluginId → display name)
  const RUNTIME_LABELS: Record<string, string> = {};
  for (const pkg of packages) {
    const name = resolveDisplayName(pkg.displayName, i18n.language);
    if (name) RUNTIME_LABELS[pkg.name] = name;
  }

  const statuses = deriveStatuses(steps, RUNTIME_LABELS);

  if (statuses.length === 0 && executing) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        <span>{t("session.startingUp")}</span>
      </div>
    );
  }

  if (statuses.length === 0) return null;

  const active = statuses.find(
    (r) => r.status === "running" || r.status === "llm" || r.status === "tool"
  );
  const allDone = !executing && !active;
  const canRetry = allDone && !!onRetryRuntime;

  return (
    <div className={`space-y-1 py-1 ${allDone ? "opacity-70 hover:opacity-100 transition-opacity" : ""}`}>
      {/* Header (clickable to collapse when done) */}
      {allDone && (
        <div className="flex items-center gap-2">
          <button
            onClick={() => setCollapsed((v) => !v)}
            className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
          >
            {collapsed ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />}
            <span className="uppercase tracking-wider">
              {t("session.executionSummary", { count: statuses.length })}
            </span>
          </button>
          {onRetryAll && (
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
      )}

      {/* Chips row */}
      {!collapsed && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {statuses.map((rt) => (
            <RuntimeChip
              key={rt.runtimeId}
              rt={rt}
              canRetry={canRetry}
              onRetry={onRetryRuntime}
              retryFromLabel={t("session.retryFrom", { label: rt.label })}
            />
          ))}
        </div>
      )}

      {/* Active detail line */}
      {active && (
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground animate-pulse">
          <Loader2 className="w-3 h-3 animate-spin shrink-0" />
          <span className="truncate">
            {active.label}
            {active.status === "llm" && ` — ${t("session.statusLlm")}`}
            {active.status === "tool" && active.toolName && ` — ${active.toolName}`}
            {active.status === "running" && ` — ${t("session.statusPreparing")}`}
            ...
          </span>
        </div>
      )}
    </div>
  );
}
