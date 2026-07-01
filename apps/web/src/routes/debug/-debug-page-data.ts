import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import type * as api from "@/services/api.js";
import * as apiClient from "@/services/api.js";
import type { EventCategory } from "./-debug-helpers.js";
import {
  getStoryTurnCount,
  getVisibleTurns,
  mergeTurnPages,
  traceEventMatchesCategory,
  type DebugView,
} from "./-debug-page-model.js";

export type SessionSnapshot = Awaited<
  ReturnType<typeof apiClient.getSessionSnapshot>
>;

export function useDebugPageData(sid: string | undefined) {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<api.SessionRecord[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    sid ?? null,
  );
  const [turns, setTurns] = useState<api.TurnTrace[]>([]);
  // 游标分页：olderCursor 指向已加载最旧一段的更前一步；null 表示已到 trace
  // 起点或已通过「加载全部」拉全量，此时展示数据即完整（无窗口失真）。
  const [olderCursor, setOlderCursor] = useState<api.TraceCursor | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loading, setLoading] = useState(false);
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
  const [snapshotData, setSnapshotData] = useState<SessionSnapshot | null>(
    null,
  );
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
      if (!selectedSessionId && allSessions.length > 0) {
        const target =
          sid && allSessions.some((session) => session.id === sid)
            ? sid
            : allSessions[0].id;
        setSelectedSessionId(target);
      }
    } catch {
      // The debugger remains usable when the server is unavailable.
    }
  }, [selectedSessionId, sid]);

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
      setTurns(data.turns);
      setOlderCursor(data.nextCursor);
      setTraceDiscovery(data.discovery ?? null);
      expandLatestTurn(data.turns);
    } catch {
      setTurns([]);
      setOlderCursor(null);
      setTraceDiscovery(null);
    } finally {
      setLoading(false);
    }
  }, [selectedSessionId, expandLatestTurn]);

  // 加载更早：用 olderCursor 拉更旧一页，按 turnId 合并进现有 turns（合并边界
  // turn），并前移游标；已加载页不受影响。
  const loadOlder = useCallback(async () => {
    if (!selectedSessionId || !olderCursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const data = await apiClient.fetchTraceTurnsPage(selectedSessionId, {
        before: olderCursor,
      });
      setTurns((prev) => mergeTurnPages(prev, data.turns));
      setOlderCursor(data.nextCursor);
    } catch {
      // 保留已加载数据；失败不清空。
    } finally {
      setLoadingOlder(false);
    }
  }, [selectedSessionId, olderCursor, loadingOlder]);

  // 自动刷新：只重拉最新窗口（第一页）并按 turnId 合并进现有 turns，
  // 不 wipe 已加载的更早页，也不动 olderCursor（它可能指向更前的位置）。
  const refreshLatest = useCallback(async () => {
    if (!selectedSessionId) return;
    try {
      const data = await apiClient.fetchTraceTurnsPage(selectedSessionId);
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
      setTurns(data.turns);
      setOlderCursor(null);
      setTraceDiscovery(data.discovery ?? null);
      expandLatestTurn(data.turns);
    } catch {
      // 保留已加载数据；失败不清空。
    } finally {
      setLoading(false);
    }
  }, [selectedSessionId, expandLatestTurn]);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    loadTraces();
  }, [loadTraces]);

  useEffect(() => {
    if (debugView !== "data" || !selectedSessionId) {
      setSnapshotData(null);
      return;
    }
    apiClient
      .getSessionSnapshot(selectedSessionId)
      .then(setSnapshotData)
      .catch(() => setSnapshotData(null));
  }, [debugView, selectedSessionId]);

  useEffect(() => {
    if (!autoRefresh || !selectedSessionId) return;
    const interval = setInterval(refreshLatest, 3000);
    return () => clearInterval(interval);
  }, [autoRefresh, selectedSessionId, refreshLatest]);

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
    autoRefresh,
    filterCategory,
    expandedTurns,
    expandedRuntimes,
    selectedEvent,
    debugView,
    snapshotData,
    traceDiscovery,
    totalEvents,
    storyTurnCount,
    isPartial,
    loadingOlder,
    selectSession,
    openSelectedSession,
    loadTraces,
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
