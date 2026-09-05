import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "@/services/api.js";

export type SessionSnapshot = Awaited<ReturnType<typeof api.getSessionView>>;

export function useSessionSnapshot(
  sessionId: string | null,
  onSession: (session: SessionSnapshot["session"]) => void,
) {
  const [snapshotData, setSnapshotData] = useState<SessionSnapshot | null>(
    null,
  );
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [snapshotError, setSnapshotError] = useState(false);
  const [snapshotUpdatedAt, setSnapshotUpdatedAt] = useState<string | null>(
    null,
  );
  const currentSession = useRef(sessionId);
  currentSession.current = sessionId;
  const request = useRef(0);
  const inFlight = useRef<{ sessionId: string; generation: number } | null>(
    null,
  );

  const refreshSnapshot = useCallback(async () => {
    if (!sessionId || currentSession.current !== sessionId) return;
    if (inFlight.current?.sessionId === sessionId) return;
    const generation = ++request.current;
    inFlight.current = { sessionId, generation };
    const isCurrent = () =>
      currentSession.current === sessionId && request.current === generation;
    setSnapshotLoading(true);
    setSnapshotError(false);
    try {
      const data = await api.getSessionView(sessionId);
      if (!isCurrent()) return;
      setSnapshotData(data);
      setSnapshotUpdatedAt(new Date().toISOString());
      onSession(data.session);
    } catch {
      // Keep the last successful snapshot, clearly marked as stale in the UI.
      if (isCurrent()) setSnapshotError(true);
    } finally {
      if (inFlight.current?.generation === generation) inFlight.current = null;
      if (isCurrent()) setSnapshotLoading(false);
    }
  }, [sessionId, onSession]);

  useEffect(() => {
    setSnapshotData(null);
    setSnapshotUpdatedAt(null);
    setSnapshotError(false);
    setSnapshotLoading(false);
    return () => {
      request.current += 1;
      inFlight.current = null;
    };
  }, [refreshSnapshot]);

  return {
    snapshotData,
    snapshotLoading,
    snapshotError,
    snapshotUpdatedAt,
    refreshSnapshot,
  };
}
