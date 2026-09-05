import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PageCursor } from "@covel/shared";
import type * as api from "@/services/api.js";
import * as apiClient from "@/services/api.js";
import type { EventCategory } from "./-debug-helpers.js";
import { useSessionExecution } from "./-use-session-execution.js";
import {
  useSessionSnapshot,
  type SessionSnapshot,
} from "./-use-session-snapshot.js";
export type { SessionSnapshot } from "./-use-session-snapshot.js";
import {
  getStoryTurnCount,
  getVisibleTurns,
  mergeTurnPages,
  traceEventMatchesCategory,
  type DebugView,
} from "./-debug-page-model.js";

export function useDebugPageData(sid: string | undefined) {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<api.SessionRecord[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    sid ?? null,
  );
  const [turns, setTurns] = useState<api.TurnTrace[]>([]);
  // 游标分页：olderCursor 指向已加载最旧一段的更前一步；null 表示已到 trace
  // 起点或已通过「加载全部」拉全量，此时展示数据即完整（无窗口失真）。
  const [olderCursor, setOlderCursor] = useState<PageCursor | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [filterCategory, setFilterCategory] = useState<EventCategory | null>(
    null,
  );
  const [expandedTurns, setExpandedTurns] = useState<Set<string>>(new Set());
  const [expandedRuntimes, setExpandedRuntimes] = useState<Set<string>>(
    new Set(),
  );
  const [selectedEvent, setSelectedEvent] = useState<api.TraceEvent | null>(
    null,
  );
  const [debugView, setDebugView] = useState<DebugView>("traces");
  const currentSession = useRef(selectedSessionId);
  currentSession.current = selectedSessionId;
  const updateSession = useCallback((session: SessionSnapshot["session"]) => {
    setSessions((previous) =>
      previous.map((item) =>
        item.id === session.id ? { ...item, ...session } : item,
      ),
    );
  }, []);
  const snapshot = useSessionSnapshot(selectedSessionId, updateSession);
  const { refreshSnapshot } = snapshot;
  const { execution, refreshExecution } =
    useSessionExecution(selectedSessionId);
  const [traceDiscovery, setTraceDiscovery] =
    useState<api.TraceDiscovery | null>(null);

  const selectSession = useCallback(
    (id: string) => {
      setSelectedSessionId(id);
      navigate({ to: "/debug", search: { sid: id }, replace: true });
    },
    [navigate],
  );

  const openSelectedSession = useCallback(() => {
    if (!selectedSessionId) return;
    navigate({ to: "/session", search: { sid: selectedSessionId } });
  }, [navigate, selectedSessionId]);

  const loadSessions = useCallback(async () => {
    try {
      const worlds = await apiClient.listWorlds();
      const allSessions: api.SessionRecord[] = [];
      for (const world of worlds) {
        const worldSessions = await apiClient.listSessions(world.id);
        allSessions.push(...worldSessions);
      }
      allSessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      setSessions(allSessions);
      if (!currentSession.current && allSessions.length > 0) {
        const target =
          sid && allSessions.some((session) => session.id === sid)
            ? sid
            : allSessions[0].id;
        setSelectedSessionId(target);
      }
    } catch {
      // The debugger remains usable when the server is unavailable.
    }
  }, [sid]);

  // 展开最新（正序数组的最后一个）turn，便于用户直接看到最近一轮。
  const expandLatestTurn = useCallback((loaded: api.TurnTrace[]) => {
    if (loaded.length === 0) return;
    const latestId = loaded[loaded.length - 1].turnId;
    setExpandedTurns((prev) => {
      const next = new Set(prev);
      next.add(latestId);
      return next;
    });
  }, []);

  // 默认加载：拉最近一段窗口（第一页），重置游标。切换会话 / 手动刷新走这里。
  const loadTraces = useCallback(async () => {
    if (!selectedSessionId) return;
    setLoading(true);
    try {
      const data = await apiClient.fetchTraceTurnsPage(selectedSessionId);
      if (currentSession.current !== selectedSessionId) return;
      setTurns(data.turns);
      setOlderCursor(data.nextCursor);
      setTraceDiscovery(data.discovery ?? null);
      expandLatestTurn(data.turns);
    } catch {
      if (currentSession.current !== selectedSessionId) return;
      setTurns([]);
      setOlderCursor(null);
      setTraceDiscovery(null);
    } finally {
      if (currentSession.current === selectedSessionId) setLoading(false);
    }
  }, [selectedSessionId, expandLatestTurn]);

  // 加载更早：用 olderCursor 拉更旧一页，按 turnId 合并进现有 turns（合并边界
  // turn），并前移游标；已加载页不受影响。
  const loadOlder = useCallback(async () => {
    if (!selectedSessionId || !olderCursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const data = await apiClient.fetchTraceTurnsPage(selectedSessionId, {
        cursor: olderCursor,
      });
      if (currentSession.current !== selectedSessionId) return;
      setTurns((prev) => mergeTurnPages(prev, data.turns));
      setOlderCursor(data.nextCursor);
    } catch {
      // 保留已加载数据；失败不清空。
    } finally {
      if (currentSession.current === selectedSessionId) setLoadingOlder(false);
    }
  }, [selectedSessionId, olderCursor, loadingOlder]);

  // 自动刷新：只重拉最新窗口（第一页）并按 turnId 合并进现有 turns，
  // 不 wipe 已加载的更早页，也不动 olderCursor（它可能指向更前的位置）。
  const refreshLatest = useCallback(async () => {
    if (!selectedSessionId) return;
    try {
      const data = await apiClient.fetchTraceTurnsPage(selectedSessionId);
      if (currentSession.current !== selectedSessionId) return;
      setTurns((prev) => mergeTurnPages(prev, data.turns));
      if (data.discovery) setTraceDiscovery(data.discovery);
    } catch {
      // 轮询失败静默：保留已加载数据。
    }
  }, [selectedSessionId]);

  // 兜底：拉全量 turn，整体替换并清空游标（展示数据即完整）。
  const loadAll = useCallback(async () => {
    if (!selectedSessionId) return;
    setLoading(true);
    try {
      const data = await apiClient.fetchTraceTurns(selectedSessionId);
      if (currentSession.current !== selectedSessionId) return;
      setTurns(data.turns);
      setOlderCursor(null);
      setTraceDiscovery(data.discovery ?? null);
      expandLatestTurn(data.turns);
    } catch {
      // 保留已加载数据；失败不清空。
    } finally {
      if (currentSession.current === selectedSessionId) setLoading(false);
    }
  }, [selectedSessionId, expandLatestTurn]);

  useEffect(() => {
    void loadSessions().then(refreshSnapshot);
  }, [loadSessions, refreshSnapshot]);

  useEffect(() => {
    setTurns([]);
    setOlderCursor(null);
    setLoadingOlder(false);
    setSelectedEvent(null);
    loadTraces();
  }, [loadTraces]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        loadTraces(),
        loadSessions().then(refreshSnapshot),
        refreshExecution(),
      ]);
    } finally {
      setRefreshing(false);
    }
  }, [loadTraces, loadSessions, refreshSnapshot, refreshExecution]);

  useEffect(() => {
    if (!autoRefresh || !selectedSessionId) return;
    const interval = setInterval(() => {
      void refreshLatest();
      void refreshSnapshot();
      void refreshExecution();
    }, 3000);
    return () => clearInterval(interval);
  }, [
    autoRefresh,
    selectedSessionId,
    refreshLatest,
    refreshSnapshot,
    refreshExecution,
  ]);

  const toggleTurn = useCallback((turnId: string) => {
    setExpandedTurns((prev) => {
      const next = new Set(prev);
      if (next.has(turnId)) next.delete(turnId);
      else next.add(turnId);
      return next;
    });
  }, []);

  const toggleRuntime = useCallback((key: string) => {
    setExpandedRuntimes((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const totalEvents = useMemo(
    () => turns.reduce((acc, turn) => acc + turn.eventCount, 0),
    [turns],
  );

  const storyTurnCount = useMemo(() => getStoryTurnCount(turns), [turns]);

  const visibleTurns = useMemo(() => getVisibleTurns(turns), [turns]);

  // 仍有更早未加载的事件：展示的计数/成本聚合只是「当前窗口」，非全会话。
  const isPartial = olderCursor !== null;

  const filterMatchesEvent = useCallback(
    (event: api.TraceEvent) => traceEventMatchesCategory(event, filterCategory),
    [filterCategory],
  );

  return {
    sessions,
    selectedSessionId,
    turns,
    visibleTurns,
    loading,
    refreshing,
    autoRefresh,
    filterCategory,
    expandedTurns,
    expandedRuntimes,
    selectedEvent,
    debugView,
    ...snapshot,
    execution,
    traceDiscovery,
    totalEvents,
    storyTurnCount,
    isPartial,
    loadingOlder,
    selectSession,
    openSelectedSession,
    loadTraces,
    refresh,
    loadOlder,
    loadAll,
    setAutoRefresh,
    setFilterCategory,
    setSelectedEvent,
    setDebugView,
    toggleTurn,
    toggleRuntime,
    filterMatchesEvent,
  };
}

export type DebugPageData = ReturnType<typeof useDebugPageData>;
