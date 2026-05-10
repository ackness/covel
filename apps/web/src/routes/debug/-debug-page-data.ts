import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import type * as api from "@/services/api.js";
import * as apiClient from "@/services/api.js";
import type { EventCategory } from "./-debug-helpers.js";
import {
  getStoryTurnCount,
  getVisibleTurns,
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

  const loadTraces = useCallback(async () => {
    if (!selectedSessionId) return;
    setLoading(true);
    try {
      const data = await apiClient.fetchTraceTurns(selectedSessionId);
      setTurns(data.turns);
      setTraceDiscovery(data.discovery ?? null);
      if (data.turns.length > 0) {
        setExpandedTurns((prev) => {
          const next = new Set(prev);
          next.add(data.turns[data.turns.length - 1].turnId);
          return next;
        });
      }
    } catch {
      setTurns([]);
      setTraceDiscovery(null);
    } finally {
      setLoading(false);
    }
  }, [selectedSessionId]);

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
    const interval = setInterval(loadTraces, 3000);
    return () => clearInterval(interval);
  }, [autoRefresh, selectedSessionId, loadTraces]);

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
    selectSession,
    openSelectedSession,
    loadTraces,
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
