import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import {
  Terminal, Activity, ChevronDown, ChevronRight, RefreshCw,
  Zap, Wrench, CheckCircle2, XCircle, MessageSquare, Database,
  Layers, Clock, Filter, Radio, Box, FileJson, Gamepad2, Shield,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import * as api from "@/services/api.js";

interface DebugSearchParams {
  sid?: string;
}

export const Route = createFileRoute("/debug")({
  component: DebugPage,
  validateSearch: (search: Record<string, unknown>): DebugSearchParams => ({
    sid: typeof search.sid === "string" ? search.sid : undefined,
  }),
});

// ── Event type styling ────────────────────────────────────────────

type EventCategory = "flow" | "runtime" | "llm" | "tool" | "message" | "block" | "state" | "hook";

function categorize(type: string): EventCategory {
  if (type.startsWith("flow.")) return "flow";
  if (type.startsWith("runtime.")) return "runtime";
  if (type.startsWith("hook.")) return "hook";
  if (type.startsWith("message.")) return "message";
  if (type.startsWith("block.")) return "block";
  if (type.startsWith("state.")) return "state";
  if (type.startsWith("llm.") || type.includes("llm")) return "llm";
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
  hook:    { color: "text-rose-500",   bg: "bg-rose-500/10",   border: "border-rose-500/20",  icon: Shield },
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

    // Determine status from the outer type (runtime lifecycle events drive state).
    if (evt.type === "runtime.completed") {
      info.status = "completed";
      info.completedAt = evt.timestamp;
    } else if (evt.type === "runtime.failed") {
      info.status = "failed";
      info.completedAt = evt.timestamp;
    }
  }

  return Array.from(map.values());
}

// ── Time formatting ───────────────────────────────────────────────

interface FmtTimeOptions {
  /** Append `.mmm` milliseconds. Default true — useful for trace events. */
  withMillis?: boolean;
  /** Force the date prefix even when the timestamp is today. */
  alwaysDate?: boolean;
}

/**
 * Render an ISO timestamp without the noise of "today's full date" but
 * still self-describing across days:
 *
 *   today          → `15:23:45.123`
 *   earlier year   → `2025-12-31 15:23:45.123`
 *   this year      → `04-27 15:23:45.123`
 *
 * When `alwaysDate` is set, the prefix is rendered even for today — used
 * by surfaces (session lists, archived runs) that benefit from an absolute
 * timestamp regardless of when the user is reading.
 */
function fmtTime(iso: string, opts: FmtTimeOptions = {}): string {
  const { withMillis = true, alwaysDate = false } = opts;
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    const sameYear = d.getFullYear() === now.getFullYear();

    const locale = i18n.language || "zh-CN";
    const timeOpts: Intl.DateTimeFormatOptions = withMillis
      ? { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }
      : { hour12: false, hour: "2-digit", minute: "2-digit" };
    const time = d.toLocaleTimeString(locale, timeOpts)
      + (withMillis ? "." + String(d.getMilliseconds()).padStart(3, "0") : "");

    if (sameDay && !alwaysDate) return time;

    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    if (sameYear) return `${mm}-${dd} ${time}`;
    return `${d.getFullYear()}-${mm}-${dd} ${time}`;
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
  const { t } = useTranslation();
  const { sid } = Route.useSearch();
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<api.SessionRecord[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(sid ?? null);
  const [turns, setTurns] = useState<api.TurnTrace[]>([]);
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [filterCategory, setFilterCategory] = useState<EventCategory | null>(null);
  const [expandedTurns, setExpandedTurns] = useState<Set<string>>(new Set());
  const [expandedRuntimes, setExpandedRuntimes] = useState<Set<string>>(new Set());
  const [selectedEvent, setSelectedEvent] = useState<api.TraceEvent | null>(null);
  const [debugView, setDebugView] = useState<"traces" | "data">("traces");
  const [snapshotData, setSnapshotData] = useState<Awaited<ReturnType<typeof api.getSessionSnapshot>> | null>(null);

  // Sync URL when selected session changes
  const selectSession = useCallback((id: string) => {
    setSelectedSessionId(id);
    navigate({ to: "/debug", search: { sid: id }, replace: true });
  }, [navigate]);

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
      // Auto-select: prefer sid from URL, else first session
      if (!selectedSessionId && allSessions.length > 0) {
        const target = sid && allSessions.some((s) => s.id === sid)
          ? sid
          : allSessions[0].id;
        setSelectedSessionId(target);
      }
    } catch {
      // silently fail
    }
  }, [selectedSessionId, sid]);

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

  // Load snapshot when switching to data view
  useEffect(() => {
    if (debugView !== "data" || !selectedSessionId) { setSnapshotData(null); return; }
    api.getSessionSnapshot(selectedSessionId).then(setSnapshotData).catch(() => setSnapshotData(null));
  }, [debugView, selectedSessionId]);

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
  // Header counter mirrors session.turnCount semantics — manual plugin-rpc
  // invocations don't advance the main loop, so don't inflate the badge.
  const storyTurnCount = useMemo(
    () =>
      turns.reduce((acc, t) => {
        const isManual = t.events.some(
          (e) =>
            e.type === "turn.started" &&
            e.payload &&
            typeof e.payload === "object" &&
            (e.payload as Record<string, unknown>).manualTrigger,
        );
        return acc + (isManual ? 0 : 1);
      }, 0),
    [turns],
  );

  return (
    <div className="flex h-full w-full flex-col border-t border-[var(--rule-color)] overflow-hidden">
      {/* ── Header ── */}
      <div className="flex-shrink-0 h-11 px-4 border-b border-[var(--rule-color)] flex items-center justify-between gap-4" style={{ background: "var(--surface-page)" }}>
        <div className="flex items-center gap-3">
          <h1 className="flex items-baseline gap-3">
            <span className="ui-meta text-[10px] text-muted-foreground">§ TRACE</span>
            <span className="ui-title text-sm font-semibold tracking-tight">{t("debugger.title")}</span>
            <Terminal className="w-3.5 h-3.5 opacity-50" />
          </h1>
          {selectedSessionId && (
            <Badge variant="outline" className="font-mono text-[10px]">
              {t("debugger.turn", { count: storyTurnCount })} · {totalEvents} {t("session.events")}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          {selectedSessionId && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[11px] text-muted-foreground gap-1"
              onClick={() => navigate({ to: "/session", search: { sid: selectedSessionId } })}
            >
              <Gamepad2 className="w-3 h-3" />
              {t("debugger.toSession")}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className={`h-7 px-2 text-[11px] gap-1 ${autoRefresh ? "text-emerald-500" : "text-muted-foreground"}`}
            onClick={() => setAutoRefresh((v) => !v)}
          >
            <Radio className={`w-3 h-3 ${autoRefresh ? "animate-pulse" : ""}`} />
            {autoRefresh ? t("debugger.live") : t("debugger.auto")}
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
        <div className="w-56 flex-shrink-0 border-r border-[var(--rule-color)] flex flex-col min-h-0 ui-rail">
          <div className="px-3 py-2 border-b border-[var(--rule-color)]">
            <h2 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              {t("debugger.sessions")}
            </h2>
          </div>
          <ScrollArea className="flex-1 min-h-0">
            <div className="p-1.5 space-y-0.5">
              {sessions.length === 0 && (
                <p className="text-[11px] text-muted-foreground italic px-2 py-3">{t("debugger.noSessions")}</p>
              )}
              {sessions.map((s) => (
                <button
                  key={s.id}
                  onClick={() => selectSession(s.id)}
                  className={`w-full text-left px-2.5 py-2 text-[11px] border transition-colors ${selectedSessionId === s.id
                    ? "border-primary/40 bg-primary/5 text-foreground"
                    : "border-transparent hover:border-border hover:bg-muted/20 text-muted-foreground"
                    }`}
                >
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <div className={`w-1.5 h-1.5 rounded-full ${s.status === "active" ? "bg-emerald-500" : "bg-zinc-400"
                      }`} />
                    <span className="font-mono truncate text-[10px]">{s.id}</span>
                  </div>
                  <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                    <Badge variant="secondary" className="text-[9px] h-4 px-1">{s.status} · t{s.turnCount}</Badge>
                    <span title={s.createdAt}>{fmtTime(s.createdAt, { withMillis: false, alwaysDate: true })}</span>
                  </div>
                </button>
              ))}
            </div>
          </ScrollArea>
        </div>

        {/* ── Main Content ── */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          {/* View Tabs + Filter Bar */}
          <div className="flex-shrink-0 h-9 px-4 border-b border-[var(--rule-color)] ui-rail flex items-center gap-4 overflow-x-auto">
            {/* View switcher */}
            <div className="flex items-center gap-1 shrink-0 border-r border-[var(--rule-color)] pr-3">
              <button
                onClick={() => setDebugView("traces")}
                className={`px-2 py-0.5 text-[10px] uppercase tracking-wider border transition-colors ${debugView === "traces"
                  ? "border-primary/40 bg-primary/10 text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
                  }`}
              >
                {t("debugger.traces")}
              </button>
              <button
                onClick={() => setDebugView("data")}
                className={`px-2 py-0.5 text-[10px] uppercase tracking-wider border transition-colors ${debugView === "data"
                  ? "border-primary/40 bg-primary/10 text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
                  }`}
              >
                {t("debugger.sessionData")}
              </button>
            </div>
            {debugView === "traces" && (
              <>
                <Filter className="w-3 h-3 text-muted-foreground shrink-0" />
                <button
                  onClick={() => setFilterCategory(null)}
                  className={`px-2 py-0.5 text-[10px] uppercase tracking-wider border transition-colors shrink-0 ${filterCategory === null
                    ? "border-primary/40 bg-primary/10 text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                    }`}
                >
                  {t("debugger.all")}
                </button>
                {(Object.keys(CATEGORY_STYLES) as EventCategory[]).map((cat) => {
                  const style = CATEGORY_STYLES[cat];
                  return (
                    <button
                      key={cat}
                      onClick={() => setFilterCategory(filterCategory === cat ? null : cat)}
                      className={`px-2 py-0.5 text-[10px] uppercase tracking-wider border transition-colors shrink-0 flex items-center gap-1 ${filterCategory === cat
                        ? `${style.border} ${style.bg} ${style.color}`
                        : "border-transparent text-muted-foreground hover:text-foreground"
                        }`}
                    >
                      <style.icon className="w-2.5 h-2.5" />
                      {t(`debugger.category.${cat}`, cat)}
                    </button>
                  );
                })}
              </>
            )}
          </div>

          {/* Content area — switches between Traces and Session Data */}
          <div className="flex flex-1 min-h-0 overflow-hidden">
            {debugView === "data" ? (
              /* ── Session Data Panel ── */
              <ScrollArea className="flex-1 min-h-0">
                <div className="p-4 max-w-5xl space-y-4">
                  {!selectedSessionId && (
                    <p className="text-sm text-muted-foreground py-20 text-center">{t("debugger.selectSession")}</p>
                  )}
                  {selectedSessionId && !snapshotData && (
                    <p className="text-sm text-muted-foreground py-20 text-center">{t("debugger.loadingSessionData")}</p>
                  )}
                  {snapshotData && (
                    <>
                      {/* Session Info */}
                      <DataSection title={t("debugger.dataSection.session")} icon={<Layers className="w-3.5 h-3.5" />}>
                        <JsonBlock data={{
                          id: snapshotData.session.id,
                          worldId: snapshotData.session.worldId,
                          // `phase` here is a derived display label the
                          // snapshot builder computes from status+turnCount —
                          // not the obsolete SessionRecord.phase field.
                          phase: snapshotData.session.phase,
                          turnCount: snapshotData.session.turnCount,
                          locale: snapshotData.session.locale,
                        }} />
                      </DataSection>

                      {/* Characters */}
                      <DataSection title={`${t("debugger.dataSection.characters")} (${snapshotData.characters.length})`} icon={<Gamepad2 className="w-3.5 h-3.5" />}>
                        {snapshotData.characters.length === 0
                          ? <p className="text-xs text-muted-foreground italic">{t("debugger.noCharactersCreated")}</p>
                          : snapshotData.characters.map((ch) => (
                            <div key={ch.id} className="border border-border p-2 space-y-1">
                              <div className="flex items-center gap-2">
                                <span className="text-xs font-semibold">{ch.name}</span>
                                <Badge variant="outline" className="text-[9px]">{ch.type}</Badge>
                              </div>
                              {ch.description && <p className="text-[11px] text-muted-foreground">{ch.description}</p>}
                              {ch.fields && <JsonBlock data={ch.fields} />}
                            </div>
                          ))
                        }
                      </DataSection>

                      {/* Messages */}
                      <DataSection title={`${t("debugger.dataSection.messages")} (${snapshotData.messages.length})`} icon={<MessageSquare className="w-3.5 h-3.5" />}>
                        {snapshotData.messages.length === 0
                          ? <p className="text-xs text-muted-foreground italic">{t("debugger.noMessages")}</p>
                          : snapshotData.messages.map((m) => (
                            <div key={m.id} className={`border p-2 text-[11px] ${m.role === "user" ? "border-blue-500/20 bg-blue-500/5" : "border-border"
                              }`}>
                              <div className="flex items-center gap-2 mb-1">
                                <Badge variant="outline" className="text-[9px]">{m.role}</Badge>
                                {m.kind && <Badge variant="outline" className="text-[9px]">{m.kind}</Badge>}
                                {m.runtimeId && <span className="text-[9px] text-muted-foreground font-mono">{m.runtimeId}</span>}
                              </div>
                              {m.content ? (
                                <p className="text-muted-foreground whitespace-pre-wrap line-clamp-3">{m.content}</p>
                              ) : m.block ? (
                                <Badge variant="outline" className="text-[9px]">{t("debugger.blockType")}: {(m.block as Record<string, unknown>).type as string}</Badge>
                              ) : null}
                            </div>
                          ))
                        }
                      </DataSection>

                      {/* Game State */}
                      <DataSection title={t("debugger.dataSection.gameState")} icon={<Database className="w-3.5 h-3.5" />}>
                        {Object.keys(snapshotData.gameState).length === 0
                          ? <p className="text-xs text-muted-foreground italic">{t("debugger.noStateData")}</p>
                          : <JsonBlock data={snapshotData.gameState} />
                        }
                      </DataSection>

                      {/* Execution Steps */}
                      <DataSection title={`${t("debugger.dataSection.executionSteps")} (${snapshotData.executionSteps.length})`} icon={<Activity className="w-3.5 h-3.5" />}>
                        {snapshotData.executionSteps.length === 0
                          ? <p className="text-xs text-muted-foreground italic">{t("debugger.noExecutionTraces")}</p>
                          : snapshotData.executionSteps.map((step, i) => (
                            <div key={i} className="flex items-center gap-2 text-[11px] font-mono py-0.5">
                              <Badge variant="outline" className="text-[9px] shrink-0">{step.type}</Badge>
                              <span className="text-muted-foreground truncate">
                                {(step.payload as Record<string, unknown>)?.runtimeId as string ?? step.turnId}
                              </span>
                              {(step.payload as Record<string, unknown>)?.durationMs != null && (
                                <span className="text-[9px] text-muted-foreground shrink-0">
                                  {(step.payload as Record<string, unknown>).durationMs as number}ms
                                </span>
                              )}
                            </div>
                          ))
                        }
                      </DataSection>
                    </>
                  )}
                </div>
              </ScrollArea>
            ) : (
              /* ── Traces Timeline (existing) ── */
              <>
                <ScrollArea className="flex-1 min-h-0">
                  <div className="p-4 space-y-2 max-w-5xl">
                    {!selectedSessionId && (
                      <div className="flex flex-col items-center justify-center py-20 text-center">
                        <Terminal className="w-8 h-8 text-muted-foreground/30 mb-3" />
                        <p className="text-sm text-muted-foreground">{t("debugger.selectSessionToInspect")}</p>
                      </div>
                    )}

                    {selectedSessionId && turns.length === 0 && !loading && (
                      <div className="flex flex-col items-center justify-center py-20 text-center">
                        <Activity className="w-8 h-8 text-muted-foreground/30 mb-3" />
                        <p className="text-sm text-muted-foreground">{t("debugger.noTraceEvents")}</p>
                        <p className="text-xs text-muted-foreground/60 mt-1">{t("debugger.eventsWillAppear")}</p>
                      </div>
                    )}

                    {(() => {
                      // Player-facing turn numbering should reflect the
                      // session's `turnCount` — i.e. only main-loop turns,
                      // not manual plugin-rpc invocations that share the
                      // trace stream. Walk in display order and increment
                      // only when the turn doesn't carry a manualTrigger
                      // marker; manual-trigger rows render as a labelled
                      // plugin invocation row inside `TurnCard` instead.
                      let storyIndex = 0;
                      return turns.map((turn) => {
                        const isManual = turn.events.some(
                          (e) =>
                            e.type === "turn.started" &&
                            e.payload &&
                            typeof e.payload === "object" &&
                            (e.payload as Record<string, unknown>).manualTrigger,
                        );
                        if (!isManual) storyIndex++;
                        return (
                          <TurnCard
                            key={turn.turnId}
                            turn={turn}
                            turnIndex={storyIndex}
                            expanded={expandedTurns.has(turn.turnId)}
                            onToggle={() => toggleTurn(turn.turnId)}
                            expandedRuntimes={expandedRuntimes}
                            onToggleRuntime={toggleRuntime}
                            filterCategory={filterCategory}
                            onSelectEvent={setSelectedEvent}
                            selectedEventSeq={selectedEvent?.seq}
                          />
                        );
                      });
                    })()}
                  </div>
                </ScrollArea>

                {/* Detail Panel */}
                {selectedEvent && (
                  <div className="w-80 flex-shrink-0 border-l border-border flex flex-col min-h-0 ui-rail">
                    <div className="px-3 py-2 border-b border-[var(--rule-color)] flex items-center justify-between">
                      <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                        {t("debugger.eventDetail")}
                      </h3>
                      <button
                        onClick={() => setSelectedEvent(null)}
                        className="text-[10px] text-muted-foreground hover:text-foreground"
                      >
                        {t("debugger.close")}
                      </button>
                    </div>
                    <ScrollArea className="flex-1 min-h-0">
                      <EventDetail event={selectedEvent} />
                    </ScrollArea>
                  </div>
                )}
              </>
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
  const { t } = useTranslation();
  const runtimes = useMemo(() => deriveRuntimesFromTurn(turn.events), [turn.events]);

  const hasError = turn.events.some(
    (e) =>
      e.type === "flow.failed" ||
      e.type === "turn.failed" ||
      (e.payload.type as string) === "runtime.failed",
  );

  // The kernel emits `turn.completed` (not `flow.completed`) at the end of
  // every turn, including manual-trigger plugin-rpc turns. Looking for the
  // wrong event name made every turn appear stuck on "running" even when it
  // had finished successfully — keep the legacy name as a fallback for any
  // older trace dumps a user might still be viewing.
  const isCompleted = turn.events.some(
    (e) => e.type === "turn.completed" || e.type === "flow.completed",
  );
  const duration = fmtDuration(turn.startedAt, turn.completedAt);

  // Manual-trigger turns (plugin-rpc invocations like a "generate image"
  // button click) don't advance the session.turnCount but still appear in
  // the trace stream because they share the same emitter pipeline. The
  // kernel tags `turn.started` with `manualTrigger.{pluginId,runtimeId}`
  // so we can label these rows distinctly instead of confusing the player
  // with an extra "回合 N" entry next to real story turns.
  const manualTrigger = useMemo(() => {
    for (const e of turn.events) {
      if (e.type !== "turn.started") continue;
      const m = e.payload?.manualTrigger as
        | { runtimeId?: string; pluginId?: string }
        | undefined;
      if (m && typeof m.runtimeId === "string") {
        return { runtimeId: m.runtimeId, pluginId: m.pluginId };
      }
    }
    return null;
  }, [turn.events]);

  // Collect runtimeIds that are already shown in the RUNTIMES section
  const runtimeEventSeqs = useMemo(() => {
    const seqs = new Set<number>();
    for (const rt of runtimes) {
      for (const evt of rt.events) seqs.add(evt.seq);
    }
    return seqs;
  }, [runtimes]);

  // Only show events NOT belonging to any runtime in the flat stream
  const orphanEvents = useMemo(() => {
    const events = runtimes.length > 0
      ? turn.events.filter((e) => !runtimeEventSeqs.has(e.seq))
      : turn.events;
    const filtered = filterCategory
      ? events.filter((e) => categorize(e.type) === filterCategory || categorize((e.payload.type as string) || e.type) === filterCategory)
      : events;
    return aggregateDeltas(filtered);
  }, [turn.events, filterCategory, runtimes, runtimeEventSeqs]);

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
          {manualTrigger ? (
            <>
              <span className="font-display font-bold text-xs uppercase tracking-wider shrink-0 text-violet-500">
                {t("debugger.pluginInvocation", { defaultValue: "插件调用" })}
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
          {/* Runtime summary */}
          {runtimes.length > 0 && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] border border-border bg-muted/10 text-muted-foreground">
              <Activity className="w-2.5 h-2.5" />
              {t("debugger.nRuntimes", { count: runtimes.length })}
              {runtimes.some((rt) => rt.status === "failed") && (
                <XCircle className="w-2.5 h-2.5 text-destructive" />
              )}
            </span>
          )}

          <Badge
            variant={hasError ? "destructive" : isCompleted ? "secondary" : "outline"}
            className="text-[9px] h-4"
          >
            {hasError ? t("debugger.error") : isCompleted ? duration : t("debugger.running")}
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
            <div className="px-3 py-2 space-y-1 border-b border-[var(--rule-color)] ui-rail">
              <h4 className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground mb-1.5">
                {t("debugger.runtimes")}
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
                    filterCategory={filterCategory}
                    onSelectEvent={onSelectEvent}
                    selectedEventSeq={selectedEventSeq}
                  />
                );
              })}
            </div>
          )}

          {/* Orphan Events (not belonging to any runtime) */}
          {orphanEvents.length > 0 && (
            <div className="divide-y divide-border/50">
              {runtimes.length > 0 && (
                <div className="px-3 py-1.5 ui-rail">
                  <h4 className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">
                    {t("debugger.flowEvents")}
                  </h4>
                </div>
              )}
              {orphanEvents.map((evt) => (
                <EventRow
                  key={evt.seq}
                  event={evt}
                  selected={selectedEventSeq === evt.seq}
                  onClick={() => onSelectEvent(evt)}
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

// ── Runtime Row ───────────────────────────────────────────────────

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

  const llmCalls = runtime.events.filter((e) => (e.payload.type as string) === "llm.calling").length;
  const toolCalls = runtime.events.filter((e) =>
    (e.payload.type as string) === "tool.calling" || (e.payload.type as string) === "tool.completed"
  ).length;

  const filteredRuntimeEvents = useMemo(() => {
    const events = filterCategory
      ? runtime.events.filter((e) => categorize(e.type) === filterCategory || categorize((e.payload.type as string) || e.type) === filterCategory)
      : runtime.events;
    return aggregateDeltas(events);
  }, [runtime.events, filterCategory]);

  return (
    <div className={`border ${runtime.status === "completed"
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

        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${runtime.status === "completed" ? "bg-emerald-500"
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

      {expanded && filteredRuntimeEvents.length > 0 && (
        <div className="border-t border-border/30 divide-y divide-border/30">
          {filteredRuntimeEvents.map((evt) => (
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
      className={`w-full text-left flex items-center gap-2 transition-colors ${compact ? "px-2.5 py-1" : "px-3 py-1.5"
        } ${selected
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

// ── Structured Data Renderer ─────────────────────────────────────

function renderStructuredData(type: string, payload: Record<string, unknown>, t: (key: string, options?: Record<string, unknown>) => string) {
  const data = payload.data as Record<string, unknown> | undefined;

  if (type === "llm.calling" && data?.messages) {
    const messages = data.messages as Array<{ role: string; content?: string; toolCalls?: unknown[]; toolCallId?: string }>;
    return (
      <div className="space-y-1.5">
        <h4 className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground flex items-center gap-1">
          <MessageSquare className="w-3 h-3" /> {t("debugger.promptMessages", { count: messages.length })}
        </h4>
        <div className="space-y-1 max-h-[400px] overflow-y-auto">
          {messages.map((msg, i) => (
            <div key={i} className={`border p-2 text-[10px] ${msg.role === "system" ? "border-blue-500/20 bg-blue-500/5"
              : msg.role === "user" ? "border-emerald-500/20 bg-emerald-500/5"
                : msg.role === "tool" ? "border-violet-500/20 bg-violet-500/5"
                  : "border-amber-500/20 bg-amber-500/5"
              }`}>
              <span className="font-mono font-bold text-[9px] uppercase">{msg.role}</span>
              {msg.toolCallId && <span className="text-[9px] text-muted-foreground ml-1">({msg.toolCallId})</span>}
              <pre className="mt-1 whitespace-pre-wrap break-all text-muted-foreground leading-relaxed max-h-[150px] overflow-y-auto">
                {msg.content || (msg.toolCalls ? JSON.stringify(msg.toolCalls, null, 2) : "")}
              </pre>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (type === "llm.responded" && data) {
    const usage = data.usage as { inputTokens?: number; outputTokens?: number } | undefined;
    const toolCalls = data.toolCalls as Array<{ id: string; name: string; arguments: string }> | undefined;
    return (
      <div className="space-y-1.5">
        {usage && (
          <div className="flex gap-3 text-[10px] text-muted-foreground">
            <span>{t("debugger.inputTokens")}: {usage.inputTokens ?? 0} tokens</span>
            <span>{t("debugger.outputTokens")}: {usage.outputTokens ?? 0} tokens</span>
          </div>
        )}
        {typeof data.text === "string" && (
          <div>
            <h4 className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground mb-1">{t("debugger.responseText")}</h4>
            <pre className="text-[10px] font-mono text-muted-foreground bg-muted/20 border border-border p-2 whitespace-pre-wrap break-all leading-relaxed max-h-[200px] overflow-y-auto">
              {data.text as string}
            </pre>
          </div>
        )}
        {toolCalls && toolCalls.length > 0 && (
          <div>
            <h4 className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground mb-1">{t("debugger.toolCalls", { count: toolCalls.length })}</h4>
            {toolCalls.map((tc, i) => (
              <div key={i} className="border border-violet-500/20 bg-violet-500/5 p-2 text-[10px] mb-1">
                <span className="font-mono font-bold">{tc.name}</span>
                <pre className="mt-1 whitespace-pre-wrap break-all text-muted-foreground">{tc.arguments}</pre>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (type === "tool.completed" && data?.result) {
    const resultStr = typeof data.result === "string" ? data.result : JSON.stringify(data.result, null, 2);
    return (
      <div>
        <h4 className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground mb-1 flex items-center gap-1">
          <Wrench className="w-3 h-3" /> {t("debugger.toolResult")}
        </h4>
        <pre className="text-[10px] font-mono text-muted-foreground bg-muted/20 border border-border p-2 whitespace-pre-wrap break-all leading-relaxed max-h-[200px] overflow-y-auto">
          {resultStr}
        </pre>
      </div>
    );
  }

  if (type === "tool.calling" && payload.detail) {
    return (
      <div>
        <h4 className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground mb-1 flex items-center gap-1">
          <Wrench className="w-3 h-3" /> {t("debugger.toolInput")}
        </h4>
        <pre className="text-[10px] font-mono text-muted-foreground bg-muted/20 border border-border p-2 whitespace-pre-wrap break-all leading-relaxed">
          {(() => { try { return JSON.stringify(JSON.parse(payload.detail as string), null, 2); } catch { return payload.detail as string; } })()}
        </pre>
      </div>
    );
  }

  return null;
}

// ── Event Detail Panel ────────────────────────────────────────────

function EventDetail({ event }: { event: api.TraceEvent }) {
  const { t } = useTranslation();
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

      {/* Structured data (messages, tool results) */}
      {renderStructuredData(displayType, event.payload, t)}

      {/* Raw Payload */}
      <details className="group">
        <summary className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground mb-1.5 flex items-center gap-1 cursor-pointer">
          <FileJson className="w-3 h-3" /> {t("debugger.rawPayload")}
        </summary>
        <pre className="text-[10px] font-mono text-muted-foreground bg-muted/20 border border-border p-2 overflow-x-auto whitespace-pre-wrap break-all leading-relaxed">
          {JSON.stringify(event.payload, null, 2)}
        </pre>
      </details>
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

/**
 * Collapse consecutive `message.delta` events into a single aggregated entry.
 * Each group of deltas sharing the same runtimeId is merged into one synthetic
 * event whose payload contains the full concatenated text and event count.
 */
function aggregateDeltas(events: api.TraceEvent[]): api.TraceEvent[] {
  const result: api.TraceEvent[] = [];
  let i = 0;

  while (i < events.length) {
    const evt = events[i];
    const innerType = evt.type === "runtime.progress"
      ? (evt.payload.type as string) || evt.type
      : evt.type;

    if (innerType !== "message.delta") {
      result.push(evt);
      i++;
      continue;
    }

    // Collect consecutive deltas with the same runtimeId
    const runtimeId = evt.payload.runtimeId as string;
    let text = String((evt.payload.delta as string) || "");
    let count = 1;
    let j = i + 1;

    while (j < events.length) {
      const next = events[j];
      const nextType = next.type === "runtime.progress"
        ? (next.payload.type as string) || next.type
        : next.type;
      if (nextType !== "message.delta" || (next.payload.runtimeId as string) !== runtimeId) break;
      text += String((next.payload.delta as string) || "");
      count++;
      j++;
    }

    // Create a synthetic aggregated event using the first event as base
    result.push({
      ...evt,
      payload: {
        ...evt.payload,
        type: "message.completed",
        content: text,
        _aggregated: count,
        _originalType: "message.delta",
      },
    });
    i = j;
  }

  return result;
}

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
    case "llm.calling": {
      const data = p.data as Record<string, unknown> | undefined;
      const msgCount = Array.isArray(data?.messages) ? (data.messages as unknown[]).length : 0;
      return `${p.detail || ""} ${msgCount > 0 ? `(${msgCount} messages)` : ""}`.trim();
    }
    case "llm.responded": {
      const data = p.data as Record<string, unknown> | undefined;
      const text = (data?.text as string) || "";
      const tcs = Array.isArray(data?.toolCalls) ? (data.toolCalls as unknown[]).length : 0;
      const usage = data?.usage as { inputTokens?: number; outputTokens?: number } | undefined;
      const usageStr = usage ? ` [${usage.inputTokens ?? 0}→${usage.outputTokens ?? 0} tok]` : "";
      if (tcs > 0) return `${tcs} tool calls${usageStr}`;
      const preview = text.slice(0, 80);
      return `${preview}${text.length > 80 ? "..." : ""}${usageStr}`;
    }
    case "tool.calling":
      return `${p.label || ""} ${(p.detail as string) || ""}`.trim();
    case "tool.completed": {
      const data = p.data as Record<string, unknown> | undefined;
      const result = data?.result;
      const resultStr = typeof result === "string" ? result : JSON.stringify(result ?? "");
      const preview = resultStr.slice(0, 80);
      return `${p.label || ""} → ${preview}${resultStr.length > 80 ? "..." : ""}`;
    }
    case "message.delta":
      return `${p.runtimeId || ""} +${String((p.delta as string) || "").length} chars`;
    case "message.completed": {
      const content = (p.content as string) || "";
      const aggregated = p._aggregated as number | undefined;
      const prefix = aggregated ? `${p.runtimeId || ""} ${content.length} chars (${aggregated} deltas) — ` : "";
      const preview = content.slice(0, 80);
      return `${prefix}${preview}${content.length > 80 ? "..." : ""}`;
    }
    case "block.emitted": {
      const block = p.block as Record<string, unknown> | undefined;
      return block ? `type: ${block.type || "unknown"}` : "";
    }
    case "state.patch.applied": {
      const patch = p.patch as Record<string, unknown> | undefined;
      return patch ? `${patch.packageName || ""} — ${patch.summary || ""}` : "";
    }
    case "flow.completed":
      return p.retry ? `retry from ${p.retryFromRuntimeId || "all"}` : "";
    case "flow.failed":
      return (p.message as string) || "";
    default:
      return "";
  }
}

// ── Session Data View Helpers ─────────────────────────────────────

function DataSection({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  const [expanded, setExpanded] = useState(true);
  return (
    <div className="border border-border">
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground ui-rail"
      >
        {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        {icon}
        {title}
      </button>
      {expanded && <div className="p-3 space-y-2">{children}</div>}
    </div>
  );
}

function JsonBlock({ data }: { data: unknown }) {
  return (
    <pre className="text-[10px] font-mono text-muted-foreground bg-muted/10 p-2 overflow-x-auto whitespace-pre-wrap break-all">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}
