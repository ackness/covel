import { useCallback, useEffect, useState } from "react";
import type { SessionRecord } from "@/services/api.js";
import { getDataService } from "@/services/data-service.js";

export function useSessionHistory(worldId: string) {
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [status, setStatus] = useState<"loading" | "success" | "error">(
    "loading",
  );
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    let current = true;
    setSessions([]);
    setStatus("loading");
    void getDataService()
      .listSessions(worldId)
      .then(
        (records) => {
          if (!current) return;
          setSessions(records);
          setStatus("success");
        },
        () => {
          if (current) setStatus("error");
        },
      );
    return () => {
      current = false;
    };
  }, [worldId, attempt]);

  return { sessions, setSessions, status, retry };
}
