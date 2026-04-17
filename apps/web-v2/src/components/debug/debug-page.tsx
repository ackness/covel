/**
 * Debug page — inspect runtime trace events per session.
 *
 * Simplified port of apps/web's /debug route. Covers the highest-value
 * features: session picker, turn timeline, event category filter, event
 * detail panel. Skips V1's Session Data snapshot tab (we can add it
 * later as a second view if someone asks).
 *
 * Lives outside the main phase-based flow in App.tsx: when the URL
 * carries `?view=debug`, App renders this component directly.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowRight,
  Box,
  ChevronDown,
  ChevronRight,
  Database,
  FileJson,
  Filter,
  Layers,
  MessageSquare,
  RefreshCw,
  Terminal,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";

import { apiClient } from "@/services/api.js";
import type { Session, TraceEvent, TurnTrace } from "@covel/api-client";

// ── Category styling ────────────────────────────────────────────

type EventCategory =
  | "flow"
  | "runtime"
  | "llm"
  | "tool"
  | "message"
  | "block"
  | "state"
  | "status";

function categorize(type: string): EventCategory {
  if (type.startsWith("flow.")) return "flow";
  if (type.startsWith("runtime.")) return "runtime";
  if (type.startsWith("message.")) return "message";
  if (type.startsWith("block.")) return "block";
  if (type.startsWith("state.")) return "state";
  if (type.startsWith("status.")) return "status";
  if (type.startsWith("llm.") || type.includes("llm")) return "llm";
  if (type.includes("tool")) return "tool";
  return "flow";
}

const CATEGORY_STYLES: Record<
  EventCategory,
  { text: string; bg: string; border: string; icon: LucideIcon; label: string }
> = {
  flow:    { text: "text-zinc-500",    bg: "bg-zinc-500/10",    border: "border-zinc-500/30",    icon: Layers,         label: "flow" },
  runtime: { text: "text-blue-500",    bg: "bg-blue-500/10",    border: "border-blue-500/30",    icon: Activity,       label: "runtime" },
  llm:     { text: "text-amber-500",   bg: "bg-amber-500/10",   border: "border-amber-500/30",   icon: Zap,            label: "llm" },
  tool:    { text: "text-violet-500",  bg: "bg-violet-500/10",  border: "border-violet-500/30",  icon: Wrench,         label: "tool" },
  message: { text: "text-cyan-500",    bg: "bg-cyan-500/10",    border: "border-cyan-500/30",    icon: MessageSquare,  label: "message" },
  block:   { text: "text-indigo-500",  bg: "bg-indigo-500/10",  border: "border-indigo-500/30",  icon: Box,            label: "block" },
  state:   { text: "text-orange-500",  bg: "bg-orange-500/10",  border: "border-orange-500/30",  icon: Database,       label: "state" },
  status:  { text: "text-emerald-500", bg: "bg-emerald-500/10", border: "border-emerald-500/30", icon: ArrowRight,     label: "status" },
};

const CATEGORY_ORDER: readonly EventCategory[] = [
  "flow",
  "runtime",
  "llm",
  "tool",
  "message",
  "block",
  "state",
  "status",
];

// ── Formatting helpers ──────────────────────────────────────────

function fmtTime(iso: string): string {
  try {
    const d = new Date(iso);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    const ms = String(d.getMilliseconds()).padStart(3, "0");
    return `${hh}:${mm}:${ss}.${ms}`;
  } catch {
    return iso;
  }
}

function fmtDuration(startIso: string, endIso: string): string {
  try {
    const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
    if (ms < 0) return "—";
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  } catch {
    return "—";
  }
}

function pickString(payload: Record<string, unknown>, key: string): string | undefined {
  const v = payload[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function pickNumber(payload: Record<string, unknown>, key: string): number | undefined {
  const v = payload[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function extractDetail(event: TraceEvent): string {
  const p = event.payload;
  const runtimeId = pickString(p, "runtimeId");
  const pluginId = pickString(p, "pluginId");
  const model = pickString(p, "model");
  const toolName = pickString(p, "toolName");
  const durationMs = pickNumber(p, "durationMs");
  const pieces: string[] = [];
  if (runtimeId) pieces.push(runtimeId);
  else if (pluginId) pieces.push(pluginId);
  if (toolName) pieces.push(`tool=${toolName}`);
  if (model) pieces.push(model);
  if (durationMs !== undefined) pieces.push(`${durationMs}ms`);
  return pieces.join(" · ");
}

// ── Main page ───────────────────────────────────────────────────

interface DebugPageProps {
  /** Initial session id from URL, if any. */
  initialSessionId?: string;
  /** Called when user navigates back to the main app. */
  onExit: () => void;
}

export function DebugPage({ initialSessionId, onExit }: DebugPageProps) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    initialSessionId ?? null,
  );
  const [turns, setTurns] = useState<TurnTrace[]>([]);
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [filterCategory, setFilterCategory] = useState<EventCategory | null>(null);
  const [expandedTurns, setExpandedTurns] = useState<Set<string>>(new Set());
  const [selectedEvent, setSelectedEvent] = useState<TraceEvent | null>(null);
  // Read inside refreshTraces without forcing the callback to re-create
  // every time a turn is toggled (which would tear down auto-refresh).
  const expandedCountRef = useRef(0);
  useEffect(() => {
    expandedCountRef.current = expandedTurns.size;
  }, [expandedTurns]);

  // Sync URL when selected session changes.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (selectedSessionId) {
      url.searchParams.set("sid", selectedSessionId);
    } else {
      url.searchParams.delete("sid");
    }
    window.history.replaceState(null, "", url.toString());
  }, [selectedSessionId]);

  // Load session list once.
  useEffect(() => {
    void (async () => {
      try {
        const list = await apiClient.sessions.list();
        setSessions(list);
        if (!selectedSessionId && list.length > 0) {
          setSelectedSessionId(list[0].id);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[debug] failed to load sessions", err);
      }
    })();
  }, []);

  const refreshTraces = useCallback(async () => {
    if (!selectedSessionId) return;
    setLoading(true);
    try {
      const list = await apiClient.traces.listTurns(selectedSessionId);
      setTurns(list);
      // Expand latest turn by default when data first arrives.
      if (list.length > 0 && expandedCountRef.current === 0) {
        setExpandedTurns(new Set([list[list.length - 1].turnId]));
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[debug] failed to load traces", err);
    } finally {
      setLoading(false);
    }
  }, [selectedSessionId]);

  // Load traces whenever selection changes.
  useEffect(() => {
    if (selectedSessionId) {
      setTurns([]);
      setSelectedEvent(null);
      setExpandedTurns(new Set());
      void refreshTraces();
    }
  }, [selectedSessionId, refreshTraces]);

  // Auto-refresh loop.
  useEffect(() => {
    if (!autoRefresh || !selectedSessionId) return;
    const id = window.setInterval(() => {
      void refreshTraces();
    }, 2000);
    return () => window.clearInterval(id);
  }, [autoRefresh, selectedSessionId, refreshTraces]);

  const toggleTurn = useCallback((turnId: string) => {
    setExpandedTurns((prev) => {
      const next = new Set(prev);
      if (next.has(turnId)) next.delete(turnId);
      else next.add(turnId);
      return next;
    });
  }, []);

  return (
    <div className="h-screen flex flex-col bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      {/* Header */}
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-zinc-200 bg-zinc-50 px-4 dark:border-zinc-800 dark:bg-zinc-900/40">
        <Terminal className="h-4 w-4 text-zinc-500" />
        <h1 className="text-xs font-semibold uppercase tracking-[0.22em] text-zinc-600 dark:text-zinc-300">
          Covel · Debug
        </h1>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setAutoRefresh((v) => !v)}
          className={`flex h-7 items-center gap-1.5 rounded-md border px-2 text-[11px] ${
            autoRefresh
              ? "border-emerald-400/60 bg-emerald-50 text-emerald-700 dark:border-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-300"
              : "border-zinc-300 bg-white text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
          }`}
          title="每 2 秒自动刷新"
        >
          <RefreshCw className={`h-3 w-3 ${autoRefresh ? "animate-spin" : ""}`} />
          {autoRefresh ? "自动刷新中" : "手动模式"}
        </button>
        <button
          type="button"
          onClick={() => void refreshTraces()}
          disabled={!selectedSessionId || loading}
          className="flex h-7 items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-2 text-[11px] text-zinc-600 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
        >
          <RefreshCw className="h-3 w-3" />
          刷新
        </button>
        <button
          type="button"
          onClick={onExit}
          className="flex h-7 items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-3 text-[11px] text-zinc-600 hover:text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100"
        >
          返回游戏
        </button>
      </div>

      {/* Body */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Sessions sidebar */}
        <div className="flex w-56 shrink-0 flex-col border-r border-zinc-200 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-900/30">
          <div className="border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
            <h2 className="text-[10px] font-semibold uppercase tracking-[0.22em] text-zinc-500 dark:text-zinc-400">
              Sessions
            </h2>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {sessions.length === 0 && (
              <p className="px-2 py-3 text-[11px] italic text-zinc-500 dark:text-zinc-400">
                没有会话
              </p>
            )}
            {sessions.map((s) => {
              const active = selectedSessionId === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSelectedSessionId(s.id)}
                  className={`mb-0.5 w-full rounded-md border px-2.5 py-2 text-left text-[11px] transition-colors ${
                    active
                      ? "border-blue-400/60 bg-blue-50 text-zinc-900 dark:border-blue-600/60 dark:bg-blue-950/40 dark:text-zinc-100"
                      : "border-transparent text-zinc-600 hover:border-zinc-300 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:bg-zinc-800/50"
                  }`}
                >
                  <div className="mb-1 flex items-center gap-1.5">
                    <span
                      className={`inline-block h-1.5 w-1.5 rounded-full ${
                        (s.turnCount ?? 0) >= 1 ? "bg-emerald-500" : "bg-zinc-400"
                      }`}
                    />
                    <span className="truncate font-mono text-[10px]">{s.id}</span>
                  </div>
                  <div className="flex items-center gap-2 text-[10px] text-zinc-500 dark:text-zinc-400">
                    <span className="rounded bg-zinc-200 px-1 py-px text-[9px] dark:bg-zinc-800">
                      {(s.turnCount ?? 0) === 0 ? "pre-game" : "playing"}
                    </span>
                    <span>
                      {new Date(s.createdAt).toLocaleTimeString("zh-CN", {
                        hour12: false,
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Main trace timeline */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Filter bar */}
          <div className="flex h-9 shrink-0 items-center gap-2 overflow-x-auto border-b border-zinc-200 bg-zinc-50/60 px-4 dark:border-zinc-800 dark:bg-zinc-900/30">
            <Filter className="h-3 w-3 shrink-0 text-zinc-500" />
            <button
              type="button"
              onClick={() => setFilterCategory(null)}
              className={`shrink-0 rounded border px-2 py-0.5 text-[10px] uppercase tracking-wider transition-colors ${
                filterCategory === null
                  ? "border-blue-400/60 bg-blue-50 text-zinc-900 dark:border-blue-600/60 dark:bg-blue-950/40 dark:text-zinc-100"
                  : "border-transparent text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
              }`}
            >
              All
            </button>
            {CATEGORY_ORDER.map((cat) => {
              const style = CATEGORY_STYLES[cat];
              const Icon = style.icon;
              const active = filterCategory === cat;
              return (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setFilterCategory(active ? null : cat)}
                  className={`flex shrink-0 items-center gap-1 rounded border px-2 py-0.5 text-[10px] uppercase tracking-wider transition-colors ${
                    active
                      ? `${style.border} ${style.bg} ${style.text}`
                      : "border-transparent text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                  }`}
                >
                  <Icon className="h-2.5 w-2.5" />
                  {style.label}
                </button>
              );
            })}
          </div>

          <div className="flex min-h-0 flex-1">
            {/* Turn timeline */}
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {!selectedSessionId && <EmptyHint text="选择左侧的会话查看 trace" />}
              {selectedSessionId && turns.length === 0 && !loading && (
                <EmptyHint text="这个会话还没有 trace 事件" />
              )}
              {selectedSessionId && loading && turns.length === 0 && (
                <EmptyHint text="正在加载 trace..." />
              )}

              {turns.map((turn, idx) => (
                <TurnCard
                  key={turn.turnId}
                  turn={turn}
                  index={idx + 1}
                  expanded={expandedTurns.has(turn.turnId)}
                  onToggle={() => toggleTurn(turn.turnId)}
                  filterCategory={filterCategory}
                  selectedEventSeq={selectedEvent?.seq}
                  onSelectEvent={setSelectedEvent}
                />
              ))}
            </div>

            {/* Event detail panel */}
            {selectedEvent && (
              <EventDetailPanel
                event={selectedEvent}
                onClose={() => setSelectedEvent(null)}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Turn card ────────────────────────────────────────────────────

interface TurnCardProps {
  turn: TurnTrace;
  index: number;
  expanded: boolean;
  onToggle: () => void;
  filterCategory: EventCategory | null;
  selectedEventSeq: number | undefined;
  onSelectEvent: (event: TraceEvent) => void;
}

function TurnCard({
  turn,
  index,
  expanded,
  onToggle,
  filterCategory,
  selectedEventSeq,
  onSelectEvent,
}: TurnCardProps) {
  const events = useMemo(() => {
    const sorted = [...turn.events].sort((a, b) => a.seq - b.seq);
    return filterCategory
      ? sorted.filter((e) => categorize(e.type) === filterCategory)
      : sorted;
  }, [turn.events, filterCategory]);

  return (
    <div className="mb-3 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/40">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 border-b border-zinc-200 bg-zinc-50/60 px-3 py-2 text-left hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900/40 dark:hover:bg-zinc-800/50"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-zinc-500" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-zinc-500" />
        )}
        <div className="flex items-baseline gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-zinc-500 dark:text-zinc-400">
            Turn {index}
          </span>
          <span className="font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
            #{turn.turnId.slice(0, 8)}
          </span>
        </div>
        <div className="flex-1" />
        <span className="text-[10px] text-zinc-500 dark:text-zinc-400">
          {turn.eventCount} events · {fmtDuration(turn.startedAt, turn.completedAt)}
        </span>
        <span className="font-mono text-[10px] text-zinc-400 dark:text-zinc-500">
          {fmtTime(turn.startedAt)}
        </span>
      </button>

      {expanded && (
        <div className="divide-y divide-zinc-100 dark:divide-zinc-800/60">
          {events.length === 0 ? (
            <div className="px-4 py-2 text-[11px] italic text-zinc-500 dark:text-zinc-400">
              没有匹配当前过滤器的事件
            </div>
          ) : (
            events.map((evt) => (
              <EventRow
                key={`${evt.seq}-${evt.type}`}
                event={evt}
                selected={selectedEventSeq === evt.seq}
                onSelect={() => onSelectEvent(evt)}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ── Event row ────────────────────────────────────────────────────

interface EventRowProps {
  event: TraceEvent;
  selected: boolean;
  onSelect: () => void;
}

function EventRow({ event, selected, onSelect }: EventRowProps) {
  const cat = categorize(event.type);
  const style = CATEGORY_STYLES[cat];
  const Icon = style.icon;
  const detail = extractDetail(event);

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-[11px] transition-colors ${
        selected
          ? "bg-blue-50 dark:bg-blue-950/40"
          : "hover:bg-zinc-50 dark:hover:bg-zinc-800/40"
      }`}
    >
      <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded ${style.bg}`}>
        <Icon className={`h-2.5 w-2.5 ${style.text}`} />
      </span>
      <span className="w-16 shrink-0 text-[10px] text-zinc-400 dark:text-zinc-500">
        {fmtTime(event.timestamp).slice(0, 8)}
      </span>
      <span className={`w-32 shrink-0 truncate ${style.text}`}>{event.type}</span>
      <span className="min-w-0 flex-1 truncate text-zinc-500 dark:text-zinc-400">
        {detail}
      </span>
      <span className="shrink-0 text-[10px] text-zinc-400 dark:text-zinc-600">
        #{event.seq}
      </span>
    </button>
  );
}

// ── Event detail panel ──────────────────────────────────────────

interface EventDetailPanelProps {
  event: TraceEvent;
  onClose: () => void;
}

function EventDetailPanel({ event, onClose }: EventDetailPanelProps) {
  return (
    <div className="flex w-80 shrink-0 flex-col border-l border-zinc-200 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-900/30">
      <div className="flex items-center justify-between border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <div className="flex items-center gap-2">
          <FileJson className="h-3 w-3 text-zinc-500" />
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.22em] text-zinc-600 dark:text-zinc-300">
            Event Detail
          </h3>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-[11px] text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
        >
          关闭
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3 text-[11px]">
        <MetaField label="type" value={event.type} mono />
        <MetaField label="seq" value={String(event.seq)} />
        <MetaField label="timestamp" value={event.timestamp} mono />
        <MetaField label="traceId" value={event.traceId || "—"} mono />
        <MetaField label="turnId" value={event.turnId || "—"} mono />
        <MetaField label="flowId" value={event.flowId || "—"} mono />

        <div className="mt-3">
          <div className="mb-1.5 text-[9px] font-semibold uppercase tracking-[0.22em] text-zinc-500 dark:text-zinc-400">
            payload
          </div>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-zinc-200 bg-white p-2 font-mono text-[10px] leading-relaxed text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300">
            {safeStringify(event.payload)}
          </pre>
        </div>
      </div>
    </div>
  );
}

function MetaField({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="mb-1.5 flex items-baseline gap-2">
      <span className="w-[72px] shrink-0 text-[9px] font-semibold uppercase tracking-[0.22em] text-zinc-400 dark:text-zinc-500">
        {label}
      </span>
      <span
        className={`min-w-0 flex-1 truncate text-zinc-700 dark:text-zinc-300 ${
          mono ? "font-mono text-[10px]" : "text-[11px]"
        }`}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// ── Empty state ──────────────────────────────────────────────────

function EmptyHint({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <Activity className="mb-3 h-7 w-7 text-zinc-400 dark:text-zinc-600" />
      <p className="text-sm text-zinc-500 dark:text-zinc-400">{text}</p>
    </div>
  );
}
