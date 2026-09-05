import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionExecutionStatus } from "@covel/shared";
import * as api from "@/services/api.js";

/** Read current ownership separately from the potentially large session snapshot. */
export function useSessionExecution(sessionId: string | null) {
  const [result, setResult] = useState<{
    sessionId: string;
    execution: SessionExecutionStatus;
  } | null>(null);
  const currentSession = useRef(sessionId);
  currentSession.current = sessionId;
  const generation = useRef(0);
  const inFlight = useRef<{ sessionId: string; generation: number } | null>(
    null,
  );

  const refreshExecution = useCallback(async () => {
    if (!sessionId || currentSession.current !== sessionId) return;
    if (inFlight.current?.sessionId === sessionId) return;
    const requestGeneration = ++generation.current;
    inFlight.current = { sessionId, generation: requestGeneration };
    try {
      const execution = await api.getSessionExecution(sessionId);
      if (
        currentSession.current === sessionId &&
        generation.current === requestGeneration
      ) {
        setResult({ sessionId, execution });
      }
    } catch {
      // A read failure is not evidence that an execution was interrupted.
    } finally {
      if (inFlight.current?.generation === requestGeneration) {
        inFlight.current = null;
      }
    }
  }, [sessionId]);

  useEffect(() => {
    setResult(null);
    void refreshExecution();
    return () => {
      generation.current += 1;
      inFlight.current = null;
    };
  }, [refreshExecution]);

  return {
    execution: result?.sessionId === sessionId ? result.execution : undefined,
    refreshExecution,
  };
}
