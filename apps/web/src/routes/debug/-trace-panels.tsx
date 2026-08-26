import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Activity,
  AlertTriangle,
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
  getDisplayType,
  getTraceData,
  getTraceError,
  isTerminalTraceFailure,
  traceEventIdentity,
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
  selectedEventId,
}: {
  turn: api.TurnTrace;
  turnIndex: number;
  expanded: boolean;
  onToggle: () => void;
  expandedRuntimes: Set<string>;
  onToggleRuntime: (key: string) => void;
  filterCategory: EventCategory | null;
  onSelectEvent: (event: api.TraceEvent) => void;
  selectedEventId?: string;
}) {
  const { t } = useTranslation();
  const runtimes = useMemo(
    () => deriveRuntimesFromTurn(turn.events),
    [turn.events],
  );

  const errorEvents = useMemo(
    () => turn.events.filter((event) => getTraceError(event) != null),
    [turn.events],
  );
  const firstErrorEvent = errorEvents[0];
  const firstError = firstErrorEvent
    ? getTraceError(firstErrorEvent)
    : undefined;
  const promptCount = turn.events.filter(
    (event) =>
      getDisplayType(event) === "llm.calling" ||
      getDisplayType(event) === "gateway.calling",
  ).length;
  const hasError = errorEvents.some(isTerminalTraceFailure);
  const isCompleted = turn.events.some(
    (event) =>
      getDisplayType(event) === "turn.completed" ||
      getDisplayType(event) === "flow.completed",
  );
  const duration = fmtDuration(turn.startedAt, turn.completedAt);

  const manualTrigger = useMemo(() => {
    for (const event of turn.events) {
      if (event.type !== "turn.started") continue;
      const manual = event.payload?.manualTrigger as
        { runtimeId?: string; pluginId?: string } | undefined;
      if (manual && typeof manual.runtimeId === "string") {
        return { runtimeId: manual.runtimeId, pluginId: manual.pluginId };
      }
    }
    return null;
  }, [turn.events]);

  const runtimeEventIds = useMemo(() => {
    const ids = new Set<string>();
    for (const runtime of runtimes) {
      for (const event of runtime.events) ids.add(traceEventIdentity(event));
    }
    return ids;
  }, [runtimes]);

  const orphanEvents = useMemo(() => {
    const events =
      runtimes.length > 0
        ? turn.events.filter(
            (event) => !runtimeEventIds.has(traceEventIdentity(event)),
          )
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
  }, [turn.events, filterCategory, runtimes, runtimeEventIds]);

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

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
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
          {firstErrorEvent && firstError && (
            <div
              className={`mt-1 flex items-center gap-1.5 min-w-0 text-[10px] ${hasError ? "text-destructive" : "text-amber-500"}`}
            >
              <XCircle className="w-3 h-3 shrink-0" />
              <span className="font-mono shrink-0">
                {firstErrorEvent.diagnostic?.runtimeId ||
                  (firstErrorEvent.payload.runtimeId as string) ||
                  getDisplayType(firstErrorEvent)}
              </span>
              <span className="truncate">{firstError.message}</span>
              {errorEvents.length > 1 && (
                <span className="shrink-0 opacity-70">
                  +{errorEvents.length - 1}
                </span>
              )}
            </div>
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

          {promptCount > 0 && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] border border-amber-500/20 bg-amber-500/5 text-amber-500">
              <Zap className="w-2.5 h-2.5" />
              {t("debugger.promptCount", { count: promptCount })}
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
            <div className="px-3 py-2 space-y-1 border-b border-(--rule-color) ui-rail">
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
                    selectedEventId={selectedEventId}
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
                  key={traceEventIdentity(event)}
                  event={event}
                  selected={selectedEventId === traceEventIdentity(event)}
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
  selectedEventId,
}: {
  runtime: RuntimeInfo;
  expanded: boolean;
  onToggle: () => void;
  filterCategory: EventCategory | null;
  onSelectEvent: (event: api.TraceEvent) => void;
  selectedEventId?: string;
}) {
  const { t } = useTranslation();
  const duration = runtime.completedAt
    ? fmtDuration(runtime.startedAt, runtime.completedAt)
    : "...";

  const llmCalls = runtime.events.filter(
    (event) =>
      getDisplayType(event) === "llm.calling" ||
      getDisplayType(event) === "gateway.calling",
  ).length;
  const toolCalls = runtime.events.filter(
    (event) => getDisplayType(event) === "tool.calling",
  ).length;
  const toolNames = Array.from(
    runtime.events.reduce((names, event) => {
      if (getDisplayType(event) !== "tool.calling") return names;
      const data = getTraceData(event.payload);
      const name =
        event.diagnostic?.tool?.name ??
        (typeof data.toolName === "string" ? data.toolName : undefined) ??
        (typeof data.label === "string" ? data.label : undefined);
      if (name) names.add(name);
      return names;
    }, new Set<string>()),
  );
  const slowWarnings = runtime.events.filter(
    (event) => event.diagnostic?.warning?.code === "slow",
  ).length;
  const errors = runtime.events
    .map((event) => ({ event, error: getTraceError(event) }))
    .filter(
      (
        item,
      ): item is {
        event: api.TraceEvent;
        error: NonNullable<typeof item.error>;
      } => item.error != null,
    );

  const filteredRuntimeEvents = useMemo(() => {
    const events = filterCategory
      ? runtime.events.filter(
          (event) => categorize(getDisplayType(event)) === filterCategory,
        )
      : runtime.events;
    return aggregateDeltas(events);
  }, [runtime.events, filterCategory]);

  return (
    <div
      className={`border ${
        runtime.status === "completed"
          ? "border-emerald-500/15 bg-emerald-500/2"
          : runtime.status === "failed"
            ? "border-destructive/15 bg-destructive/2"
            : "border-blue-500/15 bg-blue-500/2"
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

        <div className="flex-1 min-w-0">
          <div className="font-mono text-[11px] font-medium truncate">
            {runtime.label}
          </div>
          {(runtime.pluginId !== runtime.runtimeId || runtime.stage) && (
            <div className="mt-0.5 font-mono text-[9px] text-muted-foreground truncate">
              {[runtime.pluginId, runtime.stage].filter(Boolean).join(" · ")}
            </div>
          )}
          {toolNames.length > 0 && (
            <div className="mt-0.5 font-mono text-[9px] text-violet-500/80 truncate">
              {toolNames.map((name) => `${name}()`).join(" · ")}
            </div>
          )}
          {errors[0] && (
            <div
              className={`mt-0.5 text-[9px] truncate ${runtime.status === "failed" ? "text-destructive" : "text-amber-500"}`}
            >
              {getDisplayType(errors[0].event)}: {errors[0].error.message}
            </div>
          )}
        </div>

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
              {toolCalls}
            </span>
          )}
          {slowWarnings > 0 && (
            <span
              className="flex items-center gap-0.5 text-amber-500"
              title={t("debugger.slowCalls", { count: slowWarnings })}
            >
              <AlertTriangle className="w-2.5 h-2.5" />
              {slowWarnings}
            </span>
          )}
          <span className="font-mono">{duration}</span>
        </div>
      </button>

      {expanded && filteredRuntimeEvents.length > 0 && (
        <div className="border-t border-border/30 divide-y divide-border/30">
          {filteredRuntimeEvents.map((event) => (
            <EventRow
              key={traceEventIdentity(event)}
              event={event}
              compact
              selected={selectedEventId === traceEventIdentity(event)}
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
  const displayType = getDisplayType(event);

  const category = categorize(displayType);
  const style = CATEGORY_STYLES[category];
  const Icon = style.icon;
  const detail = extractDetail(event);
  const error = getTraceError(event);
  const warning = event.diagnostic?.warning?.code === "slow";
  const data = getTraceData(event.payload);
  const operationStartedAt =
    event.diagnostic?.startedAt ??
    (typeof data.startedAt === "string" ? data.startedAt : undefined);

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
      {error ? (
        <XCircle className="w-3 h-3 shrink-0 text-destructive" />
      ) : warning ? (
        <AlertTriangle className="w-3 h-3 shrink-0 text-amber-500" />
      ) : (
        <Icon className={`w-3 h-3 shrink-0 ${style.color}`} />
      )}

      <span
        className={`font-mono text-[10px] ${error ? "text-destructive" : warning ? "text-amber-500" : style.color} shrink-0 min-w-30`}
      >
        {displayType}
      </span>

      {detail && (
        <span className="text-[10px] text-muted-foreground truncate flex-1 min-w-0">
          {detail}
        </span>
      )}

      <span className="text-[9px] text-muted-foreground/60 font-mono shrink-0 ml-auto">
        {fmtTime(operationStartedAt ?? event.timestamp)}
      </span>
    </button>
  );
}
