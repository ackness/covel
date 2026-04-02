import { Loader2, CheckCircle2, XCircle, Zap, Wrench, ChevronDown, ChevronUp, RotateCw } from "lucide-react";
import { useState } from "react";
import type { ExecutionStep } from "@/stores/session-store.js";

const RUNTIME_LABELS: Record<string, string> = {
  "core-persona": "角色设定",
  "core-narrator": "叙事生成",
  "core-init-wizard": "角色创建",
  "core-guide": "引导系统",
  "core-char-tracker": "角色追踪",
};

function runtimeLabel(step: ExecutionStep): string {
  // Prefer known labels, then fall back to label from kernel (now "pluginId/kind"), then runtimeId
  if (RUNTIME_LABELS[step.runtimeId]) return RUNTIME_LABELS[step.runtimeId];
  if (RUNTIME_LABELS[step.pluginId]) return RUNTIME_LABELS[step.pluginId];
  // label from kernel is now "pluginId/kind" format
  return step.label ?? step.pluginId ?? step.runtimeId;
}

interface RuntimeStatus {
  runtimeId: string;
  pluginId: string;
  label: string;
  status: "running" | "llm" | "tool" | "completed" | "failed";
  detail?: string;
}

function deriveStatuses(steps: ExecutionStep[]): RuntimeStatus[] {
  const map = new Map<string, RuntimeStatus>();

  for (const step of steps) {
    const existing = map.get(step.runtimeId);

    switch (step.type) {
      case "runtime.started":
        map.set(step.runtimeId, {
          runtimeId: step.runtimeId,
          pluginId: step.pluginId,
          label: runtimeLabel(step),
          status: "running",
        });
        break;
      case "llm.calling":
        if (existing) {
          map.set(step.runtimeId, { ...existing, status: "llm", detail: step.detail });
        }
        break;
      case "tool.calling":
        if (existing) {
          map.set(step.runtimeId, { ...existing, status: "tool", detail: step.detail });
        }
        break;
      case "tool.completed":
        if (existing) {
          map.set(step.runtimeId, { ...existing, status: "running", detail: undefined });
        }
        break;
      case "runtime.completed":
        if (existing) {
          map.set(step.runtimeId, { ...existing, status: "completed", detail: undefined });
        }
        break;
      case "runtime.failed":
        if (existing) {
          map.set(step.runtimeId, { ...existing, status: "failed", detail: step.detail });
        }
        break;
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

function RuntimeChip({ rt, canRetry, onRetry }: { rt: RuntimeStatus; canRetry?: boolean; onRetry?: (runtimeId: string) => void }) {
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
      {rt.detail && rt.detail !== "[cached]" && (
        <span className="text-[10px] text-muted-foreground truncate max-w-[100px]">
          {rt.detail}
        </span>
      )}
      {rt.detail === "[cached]" && (
        <span className="text-[10px] text-muted-foreground/60 italic">cached</span>
      )}
      {canRetry && onRetry && (
        <button
          onClick={(e) => { e.stopPropagation(); onRetry(rt.runtimeId); }}
          className="opacity-0 group-hover:opacity-100 transition-opacity ml-0.5 p-0.5 hover:text-primary"
          title={`从 ${rt.label} 开始重试`}
        >
          <RotateCw className="w-2.5 h-2.5" />
        </button>
      )}
    </span>
  );
}

export function ExecutionTimeline({
  steps,
  executing,
  onRetryRuntime,
  onRetryAll,
}: {
  steps: ExecutionStep[];
  executing: boolean;
  /** Called to retry from a specific runtime (and all subsequent ones). */
  onRetryRuntime?: (runtimeId: string) => void;
  /** Called to retry the entire turn. */
  onRetryAll?: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const statuses = deriveStatuses(steps);

  if (statuses.length === 0 && executing) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        <span>正在启动...</span>
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
              Execution · {statuses.length} runtimes
            </span>
          </button>
          {onRetryAll && (
            <button
              onClick={onRetryAll}
              className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-primary transition-colors"
              title="重新执行所有 runtime"
            >
              <RotateCw className="w-3 h-3" />
              <span>重试全部</span>
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
            {active.status === "llm" && " — 调用模型"}
            {active.status === "tool" && active.detail && ` — ${active.detail}`}
            {active.status === "running" && " — 准备中"}
            ...
          </span>
        </div>
      )}
    </div>
  );
}
