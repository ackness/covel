import { Loader2, CheckCircle2, XCircle, Zap, Wrench, ChevronDown, ChevronUp, RotateCw, SkipForward } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ExecutionStep } from "@/stores/session-store.js";
import type { PackageSummary } from "@/services/api.js";

interface RuntimeStatus {
  runtimeId: string;
  pluginId: string;
  label: string;
  status: "running" | "llm" | "tool" | "completed" | "failed" | "skipped";
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
  // ExecutionStep is now a status-aggregation row (one per runtime per turn),
  // so derive is mostly a projection. The old event-stream logic (llm.calling
  // / tool.calling transient states) is gone — the server doesn't emit those
  // through /api/actions today, and if it ever does they'll arrive as
  // separate UPSERT_EXECUTION_STEP patches carrying status:"llm"|"tool".
  // Label resolution. Multi-runtime plugins (e.g. `core-npc-graph/rag-retriever`
  // and `core-npc-graph/extractor`) must render distinct chips, so we show the
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
    case "completed":
      return <CheckCircle2 className="w-3 h-3 text-green-500" />;
    case "failed":
      return <XCircle className="w-3 h-3 text-destructive" />;
    case "skipped":
      return <SkipForward className="w-3 h-3 text-muted-foreground" />;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
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
  const isActive = rt.status === "running" || rt.status === "llm" || rt.status === "tool";
  const resolvedDetail = resolveI18nSentinel(rt.detail, t);

  return (
    <span
      className={
        "group inline-flex items-center gap-1 px-2 py-0.5 text-[11px] border transition-colors " +
        // Paper: pill shape, dashed separators, mono label color
        "paper:rounded-full paper:px-2.5 paper:py-[3px] paper:bg-card " +
        (isActive
          ? "border-primary/30 bg-primary/5 text-foreground paper:border-[color:var(--color-primary)]/60"
          : rt.status === "failed"
            ? "border-destructive/30 bg-destructive/5 text-destructive paper:border-destructive/60"
            : rt.status === "skipped"
              ? "border-border/40 bg-muted/20 text-muted-foreground/70 italic"
              : "border-border/50 bg-muted/30 text-muted-foreground")
      }
    >
      <StatusIcon status={rt.status} />
      <span className="font-medium truncate max-w-[120px] paper:font-mono paper:text-[10px] paper:text-[color:var(--color-primary)]">{rt.label}</span>
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
      {rt.status === "failed" && resolvedDetail && (
        <span
          className="text-[10px] text-destructive/90 truncate max-w-[260px]"
          title={resolvedDetail}
        >
          {resolvedDetail}
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

/** Group steps by turnId, preserving insertion order. */
function groupStepsByTurn(steps: ExecutionStep[]): Array<{ turnId: string; steps: ExecutionStep[] }> {
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
  // Collapsed state: set of turnIds that are folded. Latest turn is always expanded.
  const [collapsedTurns, setCollapsedTurns] = useState<Set<string>>(new Set());

  // Build label map from plugin manifests (pluginId → display name)
  const RUNTIME_LABELS: Record<string, string> = {};
  for (const pkg of packages) {
    const name = resolveDisplayName(pkg.displayName, i18n.language);
    if (name) RUNTIME_LABELS[pkg.name] = name;
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

  const toggleTurn = (turnId: string) => {
    setCollapsedTurns((prev) => {
      const next = new Set(prev);
      if (next.has(turnId)) next.delete(turnId);
      else next.add(turnId);
      return next;
    });
  };

  return (
    <div className="space-y-2 py-1">
      {turnGroups.map((group, groupIdx) => {
        const statuses = deriveStatuses(group.steps, RUNTIME_LABELS);
        const isLatest = group.turnId === latestTurnId;
        const active = statuses.find(
          (r) => r.status === "running" || r.status === "llm" || r.status === "tool"
        );
        const allDone = !executing || !isLatest ? !active : false;
        const canRetry = allDone && isLatest && !!onRetryRuntime;
        const isCollapsed = collapsedTurns.has(group.turnId);
        const turnNumber = groupIdx + 1;

        return (
          <div key={group.turnId} className={`space-y-1 ${!isLatest ? "opacity-50 hover:opacity-80 transition-opacity" : ""}`}>
            {/* Turn header */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => toggleTurn(group.turnId)}
                className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
              >
                {isCollapsed ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />}
                <span className="uppercase tracking-wider font-mono">
                  {t("session.executionSummary", { count: statuses.length })}
                </span>
                <span className="text-[9px] text-muted-foreground/50 font-mono">#{turnNumber}</span>
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

            {/* Active detail line (latest turn only) */}
            {isLatest && active && (
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
      })}
    </div>
  );
}
