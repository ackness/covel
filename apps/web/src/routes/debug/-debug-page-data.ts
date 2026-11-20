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
  getVisibleTurns,
  mergeTurnPages,
  traceEventMatchesCategory,
  type DebugView,
} from "./-debug-page-model.js";

export function useDebugPageData(
  sid: string | undefined,
  view?: DebugView,
  pluginId?: string,
) {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<api.SessionRecord[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    sid ?? null,
  );
  const [turns, setTurns] = useState<api.TurnTrace[]>([]);
  // Cursor pagination: olderCursor points just before the oldest loaded page;
  // null means all trace events are loaded (via start or Load All).
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
  const traceEpoch = useRef(0);
  if (currentSession.current !== selectedSessionId) traceEpoch.current += 1;
  currentSession.current = selectedSessionId;
  const latestInFlight = useRef<{ epoch: number } | null>(null);
  useEffect(() => {
    setSelectedSessionId(sid ?? null);
  }, [sid]);
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
      navigate({
        to: "/debug",
        search: {
          sid: id,
          view,
          pluginId: view === "plugins" ? pluginId : undefined,
        },
        replace: true,
      });
    },
    [navigate, view, pluginId],
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
      const newest = allSessions[0];
      if (!currentSession.current && newest) {
        const target =
          sid && allSessions.some((session) => session.id === sid)
            ? sid
            : newest.id;
        selectSession(target);
      }
    } catch {
      // The debugger remains usable when the server is unavailable.
    }
  }, [sid, selectSession]);

  // Expand the latest (last in ascending order) turn for immediate inspection.
  const expandLatestTurn = useCallback((loaded: api.TurnTrace[]) => {
    const latest = loaded.at(-1);
    if (!latest) return;
    const latestId = latest.turnId;
    setExpandedTurns((prev) => {
      const next = new Set(prev);
      next.add(latestId);
      return next;
    });
  }, []);

  // Initial/manual load: fetch the latest window (first page) and reset cursor.
  const loadTraces = useCallback(async () => {
    if (!selectedSessionId) return;
    const epoch = ++traceEpoch.current;
    setLoadingOlder(false);
    setLoading(true);
    try {
      const data = await apiClient.fetchTraceTurnsPage(selectedSessionId);
      if (
        currentSession.current !== selectedSessionId ||
        traceEpoch.current !== epoch
      )
        return;
      setTurns(data.turns);
      setOlderCursor(data.nextCursor);
      setTraceDiscovery(data.discovery ?? null);
      expandLatestTurn(data.turns);
    } catch {
      if (
        currentSession.current !== selectedSessionId ||
        traceEpoch.current !== epoch
      )
        return;
      setTurns([]);
      setOlderCursor(null);
      setTraceDiscovery(null);
    } finally {
      if (
        currentSession.current === selectedSessionId &&
        traceEpoch.current === epoch
      )
        setLoading(false);
    }
  }, [selectedSessionId, expandLatestTurn]);

  // Load older: fetch prior page via olderCursor, merge boundary turns, advance cursor.
  const loadOlder = useCallback(async () => {
    if (!selectedSessionId || !olderCursor || loadingOlder) return;
    const epoch = traceEpoch.current;
    setLoadingOlder(true);
    try {
      const data = await apiClient.fetchTraceTurnsPage(selectedSessionId, {
        cursor: olderCursor,
      });
      if (
        currentSession.current !== selectedSessionId ||
        traceEpoch.current !== epoch
      )
        return;
      setTurns((prev) => mergeTurnPages(prev, data.turns));
      setOlderCursor(data.nextCursor);
    } catch {
      // Keep already-loaded turns on transient error.
    } finally {
      if (
        currentSession.current === selectedSessionId &&
        traceEpoch.current === epoch
      )
        setLoadingOlder(false);
    }
  }, [selectedSessionId, olderCursor, loadingOlder]);

  // Live refresh: refetch only the newest window and merge without clearing
  // previously loaded older pages or altering olderCursor.
  const refreshLatest = useCallback(async () => {
    if (!selectedSessionId) return;
    const epoch = traceEpoch.current;
    if (latestInFlight.current?.epoch === epoch) return;
    const request = { epoch };
    latestInFlight.current = request;
    try {
      const data = await apiClient.fetchTraceTurnsPage(selectedSessionId);
      if (
        currentSession.current !== selectedSessionId ||
        traceEpoch.current !== epoch
      )
        return;
      setTurns((prev) => mergeTurnPages(prev, data.turns));
      if (data.discovery) setTraceDiscovery(data.discovery);
    } catch {
      // Keep the loaded window when polling fails.
    } finally {
      if (latestInFlight.current === request) latestInFlight.current = null;
    }
  }, [selectedSessionId]);

  // Fallback: fetch the server's max single-request window and replace state.
  const loadAll = useCallback(async () => {
    if (!selectedSessionId) return;
    const epoch = ++traceEpoch.current;
    setLoadingOlder(false);
    setLoading(true);
    try {
      const data = await apiClient.fetchTraceTurns(selectedSessionId);
      if (
        currentSession.current !== selectedSessionId ||
        traceEpoch.current !== epoch
      )
        return;
      setTurns(data.turns);
      setOlderCursor(data.nextCursor ?? null);
      setTraceDiscovery(data.discovery ?? null);
      expandLatestTurn(data.turns);
    } catch {
      // Keep already-loaded turns on failure.
    } finally {
      if (
        currentSession.current === selectedSessionId &&
        traceEpoch.current === epoch
      )
        setLoading(false);
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

  const storyTurnCount =
    snapshot.snapshotData?.session.id === selectedSessionId
      ? snapshot.snapshotData.session.completedPlayerTurns
      : 0;

  const visibleTurns = useMemo(() => getVisibleTurns(turns), [turns]);

  // Earlier unloaded events remain: displayed counts/costs reflect the loaded window only.
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
