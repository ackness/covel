import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Terminal, Activity, ChevronDown, ChevronRight, RefreshCw,
  Zap, Wrench, CheckCircle2, XCircle, MessageSquare, Database,
  Layers, Clock, Filter, Radio, Box, ArrowRight, FileJson,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import * as api from "@/services/api.js";

export const Route = createFileRoute("/debug")({
  component: DebugPage,
});

// ── Event type styling ────────────────────────────────────────────

type EventCategory = "flow" | "runtime" | "llm" | "tool" | "message" | "block" | "state" | "phase";

function categorize(type: string): EventCategory {
  if (type.startsWith("flow.")) return "flow";
  if (type.startsWith("runtime.")) return "runtime";
  if (type.startsWith("message.")) return "message";
  if (type.startsWith("block.")) return "block";
  if (type.startsWith("state.")) return "state";
  if (type === "phase_change") return "phase";
  if (type.includes("llm")) return "llm";
  if (type.includes("tool")) return "tool";
  return "flow";
}

const CATEGORY_STYLES: Record<EventCategory, { color: string; bg: string; border: string; icon: typeof Activity }> = {
  flow:    { color: "text-zinc-400",   bg: "bg-zinc-500/10",   border: "border-zinc-500/20",  icon: Layers },
  runtime: { color: "text-blue-500",   bg: "bg-blue-500/10",   border: "border-blue-500/20",  icon: Activity },
  llm:     { color: "text-amber-500",  bg: "bg-amber-500/10",  border: "border-amber-500/20", icon: Zap },
  tool:    { color: "text-violet-500", bg: "bg-violet-500/10", border: "border-violet-500/20", icon: Wrench },
  message: { color: "text-cyan-500",   bg: "bg-cyan-500/10",   border: "border-cyan-500/20",  icon: MessageSquare },
  block:   { color: "text-indigo-500", bg: "bg-indigo-500/10", border: "border-indigo-500/20", icon: Box },
  state:   { color: "text-orange-500", bg: "bg-orange-500/10", border: "border-orange-500/20", icon: Database },
  phase:   { color: "text-emerald-500", bg: "bg-emerald-500/10", border: "border-emerald-500/20", icon: ArrowRight },
};

// ── Runtime status derivation ─────────────────────────────────────

interface RuntimeInfo {
  runtimeId: string;
  pluginId: string;
  label: string;
  status: "running" | "completed" | "failed";
  events: api.TraceEvent[];
  startedAt: string;
  completedAt?: string;
}

function deriveRuntimesFromTurn(events: api.TraceEvent[]): RuntimeInfo[] {
  const map = new Map<string, RuntimeInfo>();

  for (const evt of events) {
    const p = evt.payload;
    const runtimeId = (p.runtimeId as string) || "";
    if (!runtimeId) continue;

    const pluginId = (p.pluginId as string) || runtimeId;
    const label = (p.label as string) || pluginId;

    if (!map.has(runtimeId)) {
      map.set(runtimeId, {
        runtimeId,
        pluginId,
        label,
        status: "running",
        events: [],
        startedAt: evt.timestamp,
      });
    }

    const info = map.get(runtimeId)!;
    info.events.push(evt);

    const evtType = (p.type as string) || evt.type;
    if (evtType === "runtime.completed") {
      info.status = "completed";
      info.completedAt = evt.timestamp;
    } else if (evtType === "runtime.failed") {
      info.status = "failed";
      info.completedAt = evt.timestamp;
    }
  }

  return Array.from(map.values());
}

// ── Time formatting ───────────────────────────────────────────────

function fmtTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })
      + "." + String(d.getMilliseconds()).padStart(3, "0");
  } catch {
    return iso;
  }
}

function fmtDuration(startIso: string, endIso: string): string {
  try {
    const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  } catch {
    return "—";
  }
}

// ── Main Page ─────────────────────────────────────────────────────

function DebugPage() {
  const [sessions, setSessions] = useState<api.SessionRecord[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [turns, setTurns] = useState<api.TurnTrace[]>([]);
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [filterCategory, setFilterCategory] = useState<EventCategory | null>(null);
  const [expandedTurns, setExpandedTurns] = useState<Set<string>>(new Set());
  const [expandedRuntimes, setExpandedRuntimes] = useState<Set<string>>(new Set());
  const [selectedEvent, setSelectedEvent] = useState<api.TraceEvent | null>(null);

  // Load all sessions from all worlds
  const loadSessions = useCallback(async () => {
    try {
      const worlds = await api.listWorlds();
      const allSessions: api.SessionRecord[] = [];
      for (const world of worlds) {
        const worldSessions = await api.listSessions(world.id);
        allSessions.push(...worldSessions);
      }
      allSessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      setSessions(allSessions);
      // Auto-select first session if none selected
      if (!selectedSessionId && allSessions.length > 0) {
        setSelectedSessionId(allSessions[0].id);
      }
    } catch {
      // silently fail
    }
  }, [selectedSessionId]);

  // Load trace data for selected session
  const loadTraces = useCallback(async () => {
    if (!selectedSessionId) return;
    setLoading(true);
    try {
      const data = await api.fetchTraceTurns(selectedSessionId);
      setTurns(data.turns);
      // Auto-expand latest turn
      if (data.turns.length > 0) {
        setExpandedTurns((prev) => {
          const next = new Set(prev);
          next.add(data.turns[data.turns.length - 1].turnId);
          return next;
        });
      }
    } catch {
      setTurns([]);
    } finally {
      setLoading(false);
    }
  }, [selectedSessionId]);

  useEffect(() => { loadSessions(); }, [loadSessions]);
  useEffect(() => { loadTraces(); }, [loadTraces]);

  // Auto-refresh polling
  useEffect(() => {
    if (!autoRefresh || !selectedSessionId) return;
    const interval = setInterval(loadTraces, 3000);
    return () => clearInterval(interval);
  }, [autoRefresh, selectedSessionId, loadTraces]);

  const toggleTurn = (turnId: string) => {
    setExpandedTurns((prev) => {
      const next = new Set(prev);
      if (next.has(turnId)) next.delete(turnId); else next.add(turnId);
      return next;
    });
  };

  const toggleRuntime = (key: string) => {
    setExpandedRuntimes((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const totalEvents = useMemo(() => turns.reduce((acc, t) => acc + t.eventCount, 0), [turns]);

  return (
    <div className="flex h-full w-full flex-col border-t border-border overflow-hidden">
      {/* ── Header ── */}
      <div className="flex-shrink-0 h-11 px-4 border-b border-border bg-background flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <h1 className="font-display font-bold text-sm uppercase tracking-widest flex items-center gap-2">
            <Terminal className="w-4 h-4" /> Trace Inspector
          </h1>
          {selectedSessionId && (
            <Badge variant="outline" className="font-mono text-[10px]">
              {turns.length} turns · {totalEvents} events
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className={`h-7 px-2 text-[11px] gap-1 ${autoRefresh ? "text-emerald-500" : "text-muted-foreground"}`}
            onClick={() => setAutoRefresh((v) => !v)}
          >
            <Radio className={`w-3 h-3 ${autoRefresh ? "animate-pulse" : ""}`} />
            {autoRefresh ? "LIVE" : "Auto"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[11px] text-muted-foreground"
            onClick={loadTraces}
            disabled={loading}
          >
            <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* ── Left Sidebar: Sessions ── */}
        <div className="w-56 flex-shrink-0 border-r border-border flex flex-col min-h-0 bg-muted/5">
          <div className="px-3 py-2 border-b border-border">
            <h2 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              Sessions
            </h2>
          </div>
          <ScrollArea className="flex-1 min-h-0">
            <div className="p-1.5 space-y-0.5">
              {sessions.length === 0 && (
                <p className="text-[11px] text-muted-foreground italic px-2 py-3">No sessions found</p>
              )}
              {sessions.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setSelectedSessionId(s.id)}
                  className={`w-full text-left px-2.5 py-2 text-[11px] border transition-colors ${
                    selectedSessionId === s.id
                      ? "border-primary/40 bg-primary/5 text-foreground"
                      : "border-transparent hover:border-border hover:bg-muted/20 text-muted-foreground"
                  }`}
                >
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <div className={`w-1.5 h-1.5 rounded-full ${
                      s.status === "active" ? "bg-emerald-500" : "bg-zinc-400"
                    }`} />
                    <span className="font-mono truncate text-[10px]">{s.id}</span>
                  </div>
                  <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                    <Badge variant="secondary" className="text-[9px] h-4 px-1">{s.phase}</Badge>
                    <span>{new Date(s.createdAt).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" })}</span>
                  </div>
                </button>
              ))}
            </div>
          </ScrollArea>
        </div>

        {/* ── Main Content ── */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          {/* Filter Bar */}
          <div className="flex-shrink-0 h-9 px-4 border-b border-border bg-muted/5 flex items-center gap-2 overflow-x-auto">
            <Filter className="w-3 h-3 text-muted-foreground shrink-0" />
            <button
              onClick={() => setFilterCategory(null)}
              className={`px-2 py-0.5 text-[10px] uppercase tracking-wider border transition-colors shrink-0 ${
                filterCategory === null
                  ? "border-primary/40 bg-primary/10 text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              All
            </button>
            {(Object.keys(CATEGORY_STYLES) as EventCategory[]).map((cat) => {
              const style = CATEGORY_STYLES[cat];
              return (
                <button
                  key={cat}
                  onClick={() => setFilterCategory(filterCategory === cat ? null : cat)}
                  className={`px-2 py-0.5 text-[10px] uppercase tracking-wider border transition-colors shrink-0 flex items-center gap-1 ${
                    filterCategory === cat
                      ? `${style.border} ${style.bg} ${style.color}`
                      : "border-transparent text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <style.icon className="w-2.5 h-2.5" />
                  {cat}
                </button>
              );
            })}
          </div>

          {/* Trace Content */}
          <div className="flex flex-1 min-h-0 overflow-hidden">
            {/* Timeline */}
            <ScrollArea className="flex-1 min-h-0">
              <div className="p-4 space-y-2 max-w-5xl">
                {!selectedSessionId && (
                  <div className="flex flex-col items-center justify-center py-20 text-center">
                    <Terminal className="w-8 h-8 text-muted-foreground/30 mb-3" />
                    <p className="text-sm text-muted-foreground">Select a session to inspect traces</p>
                  </div>
                )}

                {selectedSessionId && turns.length === 0 && !loading && (
                  <div className="flex flex-col items-center justify-center py-20 text-center">
                    <Activity className="w-8 h-8 text-muted-foreground/30 mb-3" />
                    <p className="text-sm text-muted-foreground">No trace events recorded</p>
                    <p className="text-xs text-muted-foreground/60 mt-1">Events will appear here as turns execute</p>
                  </div>
                )}

                {turns.map((turn, turnIndex) => (
                  <TurnCard
                    key={turn.turnId}
                    turn={turn}
                    turnIndex={turnIndex + 1}
                    expanded={expandedTurns.has(turn.turnId)}
                    onToggle={() => toggleTurn(turn.turnId)}
                    expandedRuntimes={expandedRuntimes}
                    onToggleRuntime={toggleRuntime}
                    filterCategory={filterCategory}
                    onSelectEvent={setSelectedEvent}
                    selectedEventSeq={selectedEvent?.seq}
                  />
                ))}
              </div>
            </ScrollArea>

            {/* Detail Panel */}
            {selectedEvent && (
              <div className="w-80 flex-shrink-0 border-l border-border flex flex-col min-h-0 bg-muted/5">
                <div className="px-3 py-2 border-b border-border flex items-center justify-between">
                  <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                    Event Detail
                  </h3>
                  <button
                    onClick={() => setSelectedEvent(null)}
                    className="text-[10px] text-muted-foreground hover:text-foreground"
                  >
                    Close
                  </button>
                </div>
                <ScrollArea className="flex-1 min-h-0">
                  <EventDetail event={selectedEvent} />
                </ScrollArea>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Turn Card ─────────────────────────────────────────────────────

function TurnCard({
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
  const runtimes = useMemo(() => deriveRuntimesFromTurn(
    turn.events.filter((e) => e.type === "runtime.progress")
  ), [turn.events]);

  const hasError = turn.events.some(
    (e) => e.type === "flow.failed" || (e.payload.type as string) === "runtime.failed"
  );

  const isCompleted = turn.events.some((e) => e.type === "flow.completed");
  const duration = fmtDuration(turn.startedAt, turn.completedAt);

  const filteredEvents = filterCategory
    ? turn.events.filter((e) => categorize(e.type) === filterCategory || categorize((e.payload.type as string) || e.type) === filterCategory)
    : turn.events;

  return (
    <div className={`border ${hasError ? "border-destructive/30" : "border-border"} bg-card`}>
      {/* Turn Header */}
      <button
        onClick={onToggle}
        className="w-full px-3 py-2 flex items-center gap-3 text-left hover:bg-muted/10 transition-colors"
      >
        {expanded
          ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        }

        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span className="font-display font-bold text-xs uppercase tracking-wider shrink-0">
            Turn {turnIndex}
          </span>
          <span className="font-mono text-[10px] text-muted-foreground truncate">
            {turn.turnId}
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Runtime summary chips */}
          <div className="hidden sm:flex items-center gap-1">
            {runtimes.map((rt) => (
              <span
                key={rt.runtimeId}
                className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[9px] border ${
                  rt.status === "completed"
                    ? "border-emerald-500/20 bg-emerald-500/5 text-emerald-600"
                    : rt.status === "failed"
                      ? "border-destructive/20 bg-destructive/5 text-destructive"
                      : "border-blue-500/20 bg-blue-500/5 text-blue-600"
                }`}
              >
                {rt.status === "completed" && <CheckCircle2 className="w-2 h-2" />}
                {rt.status === "failed" && <XCircle className="w-2 h-2" />}
                {rt.status === "running" && <Activity className="w-2 h-2 animate-pulse" />}
                {rt.pluginId}
              </span>
            ))}
          </div>

          <Badge
            variant={hasError ? "destructive" : isCompleted ? "secondary" : "outline"}
            className="text-[9px] h-4"
          >
            {hasError ? "ERROR" : isCompleted ? duration : "RUNNING"}
          </Badge>

          <span className="text-[10px] text-muted-foreground font-mono">
            {fmtTime(turn.startedAt)}
          </span>
        </div>
      </button>

      {/* Expanded Content */}
      {expanded && (
        <div className="border-t border-border">
          {/* Runtime Breakdown */}
          {runtimes.length > 0 && (
            <div className="px-3 py-2 space-y-1 border-b border-border bg-muted/5">
              <h4 className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground mb-1.5">
                Runtimes
              </h4>
              {runtimes.map((rt) => {
                const rtKey = `${turn.turnId}:${rt.runtimeId}`;
                const rtExpanded = expandedRuntimes.has(rtKey);
                return (
                  <RuntimeRow
                    key={rt.runtimeId}
                    runtime={rt}
                    expanded={rtExpanded}
                    onToggle={() => onToggleRuntime(rtKey)}
                    onSelectEvent={onSelectEvent}
                    selectedEventSeq={selectedEventSeq}
                  />
                );
              })}
            </div>
          )}

          {/* Event Stream */}
          <div className="divide-y divide-border/50">
            {filteredEvents.map((evt) => (
              <EventRow
                key={evt.seq}
                event={evt}
                selected={selectedEventSeq === evt.seq}
                onClick={() => onSelectEvent(evt)}
              />
            ))}
            {filteredEvents.length === 0 && (
              <div className="px-3 py-4 text-center text-[11px] text-muted-foreground italic">
                No events matching filter
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Runtime Row ───────────────────────────────────────────────────

function RuntimeRow({
  runtime,
  expanded,
  onToggle,
  onSelectEvent,
  selectedEventSeq,
}: {
  runtime: RuntimeInfo;
  expanded: boolean;
  onToggle: () => void;
  onSelectEvent: (event: api.TraceEvent) => void;
  selectedEventSeq?: number;
}) {
  const duration = runtime.completedAt
    ? fmtDuration(runtime.startedAt, runtime.completedAt)
    : "...";

  const llmCalls = runtime.events.filter((e) => (e.payload.type as string) === "llm.calling").length;
  const toolCalls = runtime.events.filter((e) =>
    (e.payload.type as string) === "tool.calling" || (e.payload.type as string) === "tool.completed"
  ).length;

  return (
    <div className={`border ${
      runtime.status === "completed"
        ? "border-emerald-500/15 bg-emerald-500/[0.02]"
        : runtime.status === "failed"
          ? "border-destructive/15 bg-destructive/[0.02]"
          : "border-blue-500/15 bg-blue-500/[0.02]"
    }`}>
      <button
        onClick={onToggle}
        className="w-full px-2.5 py-1.5 flex items-center gap-2 text-left hover:bg-muted/10 transition-colors"
      >
        {expanded
          ? <ChevronDown className="w-3 h-3 text-muted-foreground" />
          : <ChevronRight className="w-3 h-3 text-muted-foreground" />
        }

        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
          runtime.status === "completed" ? "bg-emerald-500"
          : runtime.status === "failed" ? "bg-destructive"
          : "bg-blue-500 animate-pulse"
        }`} />

        <span className="font-mono text-[11px] font-medium flex-1 truncate">
          {runtime.label}
        </span>

        <div className="flex items-center gap-2 text-[10px] text-muted-foreground shrink-0">
          {llmCalls > 0 && (
            <span className="flex items-center gap-0.5">
              <Zap className="w-2.5 h-2.5 text-amber-500" />{llmCalls}
            </span>
          )}
          {toolCalls > 0 && (
            <span className="flex items-center gap-0.5">
              <Wrench className="w-2.5 h-2.5 text-violet-500" />{toolCalls / 2}
            </span>
          )}
          <span className="font-mono">{duration}</span>
        </div>
      </button>

      {expanded && runtime.events.length > 0 && (
        <div className="border-t border-border/30 divide-y divide-border/30">
          {runtime.events.map((evt) => (
            <EventRow
              key={evt.seq}
              event={evt}
              compact
              selected={selectedEventSeq === evt.seq}
              onClick={() => onSelectEvent(evt)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Event Row ─────────────────────────────────────────────────────

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
  // Use inner payload type if runtime.progress, otherwise the envelope type
  const displayType = event.type === "runtime.progress"
    ? (event.payload.type as string) || event.type
    : event.type;

  const cat = categorize(displayType);
  const style = CATEGORY_STYLES[cat];
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

      <span className={`font-mono text-[10px] ${style.color} shrink-0 min-w-[120px]`}>
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

// ── Event Detail Panel ────────────────────────────────────────────

function EventDetail({ event }: { event: api.TraceEvent }) {
  const displayType = event.type === "runtime.progress"
    ? (event.payload.type as string) || event.type
    : event.type;
  const cat = categorize(displayType);
  const style = CATEGORY_STYLES[cat];

  return (
    <div className="p-3 space-y-3">
      {/* Type header */}
      <div className={`flex items-center gap-2 px-2 py-1.5 border ${style.border} ${style.bg}`}>
        <style.icon className={`w-3.5 h-3.5 ${style.color}`} />
        <span className={`font-mono text-xs font-medium ${style.color}`}>{displayType}</span>
      </div>

      {/* Meta fields */}
      <div className="space-y-1.5">
        <MetaField label="seq" value={String(event.seq)} />
        <MetaField label="timestamp" value={fmtTime(event.timestamp)} />
        <MetaField label="turnId" value={event.turnId} mono />
        <MetaField label="traceId" value={event.traceId} mono />
        <MetaField label="flowId" value={event.flowId} mono />
        <MetaField label="requestId" value={event.requestId} mono />
      </div>

      {/* Payload */}
      <div>
        <h4 className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground mb-1.5 flex items-center gap-1">
          <FileJson className="w-3 h-3" /> Payload
        </h4>
        <pre className="text-[10px] font-mono text-muted-foreground bg-muted/20 border border-border p-2 overflow-x-auto whitespace-pre-wrap break-all leading-relaxed">
          {JSON.stringify(event.payload, null, 2)}
        </pre>
      </div>
    </div>
  );
}

function MetaField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  if (!value) return null;
  return (
    <div className="flex items-baseline gap-2 text-[10px]">
      <span className="text-muted-foreground shrink-0 min-w-[70px]">{label}</span>
      <span className={`truncate ${mono ? "font-mono" : ""} text-foreground`}>{value}</span>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────

function extractDetail(event: api.TraceEvent): string {
  const p = event.payload;
  const innerType = (p.type as string) || event.type;

  switch (innerType) {
    case "runtime.started":
      return `${p.pluginId || ""}${p.detail && p.detail !== "[cached]" ? ` — ${p.detail}` : ""}${p.detail === "[cached]" ? " (cached)" : ""}`;
    case "runtime.completed":
      return (p.pluginId as string) || "";
    case "runtime.failed":
      return `${p.pluginId || ""} — ${p.detail || "error"}`;
    case "llm.calling":
      return (p.detail as string) || "";
    case "tool.calling":
      return (p.detail as string) || "";
    case "tool.completed":
      return (p.detail as string) || "";
    case "message.delta":
      return `${p.runtimeId || ""} +${String((p.delta as string) || "").length} chars`;
    case "message.completed":
      return `${((p.content as string) || "").slice(0, 60)}${((p.content as string) || "").length > 60 ? "..." : ""}`;
    case "block.emitted": {
      const block = p.block as Record<string, unknown> | undefined;
      return block ? `type: ${block.type || "unknown"}` : "";
    }
    case "state.patch.applied": {
      const patch = p.patch as Record<string, unknown> | undefined;
      return patch ? `${patch.packageName || ""} — ${patch.summary || ""}` : "";
    }
    case "flow.phase.changed":
      return `→ ${p.phase || ""}`;
    case "flow.completed":
      return p.retry ? `retry from ${p.retryFromRuntimeId || "all"}` : "";
    case "flow.failed":
      return (p.message as string) || "";
    case "phase_change":
      return `→ ${p.phase || ""}`;
    default:
      return "";
  }
}
