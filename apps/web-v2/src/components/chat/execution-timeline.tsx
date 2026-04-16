/**
 * ExecutionTimeline — shows runtime execution progress as inline chips.
 *
 * Renders a compact row of status chips for each runtime in a turn,
 * with a live detail line for the currently active runtime.
 */

import { Loader2, CheckCircle2, XCircle } from "lucide-react";
import type { ExecutionStep } from "@/stores/session-store.js";

function StatusIcon({ status }: { status: ExecutionStep["status"] }) {
  switch (status) {
    case "running":
      return <Loader2 className="w-3 h-3 animate-spin text-blue-500" />;
    case "completed":
      return <CheckCircle2 className="w-3 h-3 text-emerald-500" />;
    case "failed":
      return <XCircle className="w-3 h-3 text-red-500" />;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

interface ExecutionTimelineProps {
  steps: ExecutionStep[];
  executing: boolean;
}

export function ExecutionTimeline({ steps, executing }: ExecutionTimelineProps) {
  if (steps.length === 0 && !executing) return null;

  if (steps.length === 0 && executing) {
    return (
      <div className="flex items-center gap-2 text-xs text-zinc-400 py-1.5">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        <span>准备中...</span>
      </div>
    );
  }

  const active = steps.find((s) => s.status === "running");

  return (
    <div className="space-y-1.5 py-1.5">
      {/* Chips row */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {steps.map((step) => {
          const isActive = step.status === "running";
          return (
            <span
              key={step.runtimeId}
              className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded border transition-colors ${
                isActive
                  ? "border-blue-300/40 bg-blue-50/60 text-zinc-700 dark:border-blue-500/30 dark:bg-blue-950/30 dark:text-zinc-200"
                  : step.status === "failed"
                    ? "border-red-300/40 bg-red-50/40 text-red-600 dark:border-red-500/30 dark:bg-red-950/20 dark:text-red-400"
                    : "border-zinc-200/60 bg-zinc-50/40 text-zinc-500 dark:border-zinc-700/50 dark:bg-zinc-800/30 dark:text-zinc-400"
              }`}
            >
              <StatusIcon status={step.status} />
              <span className="font-medium truncate max-w-[120px]">
                {step.label ?? step.runtimeId}
              </span>
              {step.durationMs != null && (
                <span className="text-[10px] text-zinc-400 dark:text-zinc-500 tabular-nums">
                  {formatDuration(step.durationMs)}
                </span>
              )}
            </span>
          );
        })}
      </div>

      {/* Active detail line */}
      {active && (
        <div className="flex items-center gap-1.5 text-[11px] text-zinc-400 animate-pulse">
          <Loader2 className="w-3 h-3 animate-spin shrink-0" />
          <span className="truncate">
            {active.label ?? active.runtimeId} — 执行中...
          </span>
        </div>
      )}
    </div>
  );
}
