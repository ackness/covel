import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Activity,
  ChevronDown,
  ChevronRight,
  Wrench,
  XCircle,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import type * as api from "@/services/api.js";
import {
  aggregateDeltas,
  categorize,
  CATEGORY_STYLES,
  deriveRuntimesFromTurn,
  extractDetail,
  fmtDuration,
  fmtTime,
  type EventCategory,
  type RuntimeInfo,
} from "./-debug-helpers.js";

export function TurnCard({
  turn,
  turnIndex,
  expanded,
  onToggle,
  expandedRuntimes,
  onToggleRuntime,
  filterCategory,
  onSelectEvent,
  selectedEventSeq,
}: {
  turn: api.TurnTrace;
  turnIndex: number;
  expanded: boolean;
  onToggle: () => void;
  expandedRuntimes: Set<string>;
  onToggleRuntime: (key: string) => void;
  filterCategory: EventCategory | null;
  onSelectEvent: (event: api.TraceEvent) => void;
  selectedEventSeq?: number;
}) {
  const { t } = useTranslation();
  const runtimes = useMemo(
    () => deriveRuntimesFromTurn(turn.events),
    [turn.events],
  );

  const hasError = turn.events.some(
    (event) =>
      event.type === "flow.failed" ||
      event.type === "turn.failed" ||
      (event.payload.type as string) === "runtime.failed",
  );
  const isCompleted = turn.events.some(
    (event) =>
      event.type === "turn.completed" || event.type === "flow.completed",
  );
  const duration = fmtDuration(turn.startedAt, turn.completedAt);

  const manualTrigger = useMemo(() => {
    for (const event of turn.events) {
      if (event.type !== "turn.started") continue;
      const manual = event.payload?.manualTrigger as
        | { runtimeId?: string; pluginId?: string }
        | undefined;
      if (manual && typeof manual.runtimeId === "string") {
        return { runtimeId: manual.runtimeId, pluginId: manual.pluginId };
      }
    }
    return null;
  }, [turn.events]);

  const runtimeEventSeqs = useMemo(() => {
    const seqs = new Set<number>();
    for (const runtime of runtimes) {
      for (const event of runtime.events) seqs.add(event.seq);
    }
    return seqs;
  }, [runtimes]);

  const orphanEvents = useMemo(() => {
    const events =
      runtimes.length > 0
        ? turn.events.filter((event) => !runtimeEventSeqs.has(event.seq))
        : turn.events;
    const filtered = filterCategory
      ? events.filter(
          (event) =>
            categorize(event.type) === filterCategory ||
            categorize((event.payload.type as string) || event.type) ===
              filterCategory,
        )
      : events;
    return aggregateDeltas(filtered);
  }, [turn.events, filterCategory, runtimes, runtimeEventSeqs]);

  return (
    <div
      className={`border ${hasError ? "border-destructive/30" : "border-border"} bg-card`}
    >
      <button
        onClick={onToggle}
        className="w-full px-3 py-2 flex items-center gap-3 text-left hover:bg-muted/10 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        )}

        <div className="flex items-center gap-2 flex-1 min-w-0">
          {manualTrigger ? (
            <>
              <span className="font-display font-bold text-xs uppercase tracking-wider shrink-0 text-violet-500">
                {t("debugger.pluginInvocation")}
              </span>
              <span className="font-mono text-[10px] text-violet-500/80 shrink-0 truncate">
                {manualTrigger.runtimeId}
              </span>
              <span className="font-mono text-[10px] text-muted-foreground/60 truncate">
                {turn.turnId}
              </span>
            </>
          ) : (
            <>
              <span className="font-display font-bold text-xs uppercase tracking-wider shrink-0">
                {t("debugger.turn", { count: turnIndex })}
              </span>
              <span className="font-mono text-[10px] text-muted-foreground truncate">
                {turn.turnId}
              </span>
            </>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {runtimes.length > 0 && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] border border-border bg-muted/10 text-muted-foreground">
              <Activity className="w-2.5 h-2.5" />
              {t("debugger.nRuntimes", { count: runtimes.length })}
              {runtimes.some((runtime) => runtime.status === "failed") && (
                <XCircle className="w-2.5 h-2.5 text-destructive" />
              )}
            </span>
          )}

          <Badge
            variant={
              hasError ? "destructive" : isCompleted ? "secondary" : "outline"
            }
            className="text-[9px] h-4"
          >
            {hasError
              ? t("debugger.error")
              : isCompleted
                ? duration
                : t("debugger.running")}
          </Badge>

          <span className="text-[10px] text-muted-foreground font-mono">
            {fmtTime(turn.startedAt)}
          </span>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border">
          {runtimes.length > 0 && (
            <div className="px-3 py-2 space-y-1 border-b border-[var(--rule-color)] ui-rail">
              <h4 className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground mb-1.5">
                {t("debugger.runtimes")}
              </h4>
              {runtimes.map((runtime) => {
                const runtimeKey = `${turn.turnId}:${runtime.runtimeId}`;
                return (
                  <RuntimeRow
                    key={runtime.runtimeId}
                    runtime={runtime}
                    expanded={expandedRuntimes.has(runtimeKey)}
                    onToggle={() => onToggleRuntime(runtimeKey)}
                    filterCategory={filterCategory}
                    onSelectEvent={onSelectEvent}
                    selectedEventSeq={selectedEventSeq}
                  />
                );
              })}
            </div>
          )}

          {orphanEvents.length > 0 && (
            <div className="divide-y divide-border/50">
              {runtimes.length > 0 && (
                <div className="px-3 py-1.5 ui-rail">
                  <h4 className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">
                    {t("debugger.flowEvents")}
                  </h4>
                </div>
              )}
              {orphanEvents.map((event) => (
                <EventRow
                  key={event.seq}
                  event={event}
                  selected={selectedEventSeq === event.seq}
                  onClick={() => onSelectEvent(event)}
                />
              ))}
            </div>
          )}
          {orphanEvents.length === 0 && runtimes.length === 0 && (
            <div className="px-3 py-4 text-center text-[11px] text-muted-foreground italic">
              {t("debugger.noEventsMatchingFilter")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RuntimeRow({
  runtime,
  expanded,
  onToggle,
  filterCategory,
  onSelectEvent,
  selectedEventSeq,
}: {
  runtime: RuntimeInfo;
  expanded: boolean;
  onToggle: () => void;
  filterCategory: EventCategory | null;
  onSelectEvent: (event: api.TraceEvent) => void;
  selectedEventSeq?: number;
}) {
  const duration = runtime.completedAt
    ? fmtDuration(runtime.startedAt, runtime.completedAt)
    : "...";

  const llmCalls = runtime.events.filter(
    (event) => (event.payload.type as string) === "llm.calling",
  ).length;
  const toolCalls = runtime.events.filter(
    (event) =>
      (event.payload.type as string) === "tool.calling" ||
      (event.payload.type as string) === "tool.completed",
  ).length;

  const filteredRuntimeEvents = useMemo(() => {
    const events = filterCategory
      ? runtime.events.filter(
          (event) =>
            categorize(event.type) === filterCategory ||
            categorize((event.payload.type as string) || event.type) ===
              filterCategory,
        )
      : runtime.events;
    return aggregateDeltas(events);
  }, [runtime.events, filterCategory]);

  return (
    <div
      className={`border ${
        runtime.status === "completed"
          ? "border-emerald-500/15 bg-emerald-500/[0.02]"
          : runtime.status === "failed"
            ? "border-destructive/15 bg-destructive/[0.02]"
            : "border-blue-500/15 bg-blue-500/[0.02]"
      }`}
    >
      <button
        onClick={onToggle}
        className="w-full px-2.5 py-1.5 flex items-center gap-2 text-left hover:bg-muted/10 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="w-3 h-3 text-muted-foreground" />
        ) : (
          <ChevronRight className="w-3 h-3 text-muted-foreground" />
        )}

        <span
          className={`w-1.5 h-1.5 rounded-full shrink-0 ${
            runtime.status === "completed"
              ? "bg-emerald-500"
              : runtime.status === "failed"
                ? "bg-destructive"
                : "bg-blue-500 animate-pulse"
          }`}
        />

        <span className="font-mono text-[11px] font-medium flex-1 truncate">
          {runtime.label}
        </span>

        <div className="flex items-center gap-2 text-[10px] text-muted-foreground shrink-0">
          {llmCalls > 0 && (
            <span className="flex items-center gap-0.5">
              <Zap className="w-2.5 h-2.5 text-amber-500" />
              {llmCalls}
            </span>
          )}
          {toolCalls > 0 && (
            <span className="flex items-center gap-0.5">
              <Wrench className="w-2.5 h-2.5 text-violet-500" />
              {toolCalls / 2}
            </span>
          )}
          <span className="font-mono">{duration}</span>
        </div>
      </button>

      {expanded && filteredRuntimeEvents.length > 0 && (
        <div className="border-t border-border/30 divide-y divide-border/30">
          {filteredRuntimeEvents.map((event) => (
            <EventRow
              key={event.seq}
              event={event}
              compact
              selected={selectedEventSeq === event.seq}
              onClick={() => onSelectEvent(event)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function EventRow({
  event,
  compact,
  selected,
  onClick,
}: {
  event: api.TraceEvent;
  compact?: boolean;
  selected?: boolean;
  onClick: () => void;
}) {
  const displayType =
    event.type === "runtime.progress"
      ? (event.payload.type as string) || event.type
      : event.type;

  const category = categorize(displayType);
  const style = CATEGORY_STYLES[category];
  const Icon = style.icon;
  const detail = extractDetail(event);

  return (
    <button
      onClick={onClick}
      className={`w-full text-left flex items-center gap-2 transition-colors ${
        compact ? "px-2.5 py-1" : "px-3 py-1.5"
      } ${
        selected
          ? "bg-primary/5 border-l-2 border-l-primary"
          : "hover:bg-muted/10 border-l-2 border-l-transparent"
      }`}
    >
      <Icon className={`w-3 h-3 shrink-0 ${style.color}`} />

      <span
        className={`font-mono text-[10px] ${style.color} shrink-0 min-w-[120px]`}
      >
        {displayType}
      </span>

      {detail && (
        <span className="text-[10px] text-muted-foreground truncate flex-1 min-w-0">
          {detail}
        </span>
      )}

      <span className="text-[9px] text-muted-foreground/60 font-mono shrink-0 ml-auto">
        {fmtTime(event.timestamp)}
      </span>
    </button>
  );
}
