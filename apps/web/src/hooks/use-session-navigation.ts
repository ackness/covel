import { useCallback, useEffect, useRef, useState } from "react";

interface SessionNavigationOptions {
  booted: boolean;
  sid?: string;
  sessionId?: string;
  hasRecovery: boolean;
  resumeSessionById: (id: string) => Promise<void>;
  backToWorldSelect: () => void;
  replaceSessionUrl: (id?: string) => void;
}

/** Reconcile URL navigation separately from session changes made inside Studio. */
export function useSessionNavigation({
  booted,
  sid,
  sessionId,
  hasRecovery,
  resumeSessionById,
  backToWorldSelect,
  replaceSessionUrl,
}: SessionNavigationOptions) {
  const previous = useRef<{ sid?: string } | null>(null);
  const pending = useRef<{ id: string } | null>(null);
  const mounted = useRef(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const resume = useCallback(
    (id: string) => {
      const request = { id };
      pending.current = request;
      setError(null);
      void resumeSessionById(id).catch((cause: unknown) => {
        if (!mounted.current || pending.current !== request) return;
        if (
          cause instanceof Error &&
          cause.message === `Session not found: ${id}`
        ) {
          replaceSessionUrl();
        } else {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    },
    [resumeSessionById, replaceSessionUrl],
  );

  useEffect(() => {
    if (!booted) return;
    const last = previous.current;
    previous.current = { sid };
    if (!last || last.sid !== sid) {
      pending.current = null;
      setError(null);
      if (sid && sid !== sessionId) resume(sid);
      else if (!sid && (sessionId || hasRecovery || last?.sid))
        backToWorldSelect();
      return;
    }
    if (pending.current) {
      if (sessionId === pending.current.id) pending.current = null;
      else return;
    }
    if (sessionId !== sid && (sessionId || !hasRecovery)) {
      replaceSessionUrl(sessionId);
    }
  }, [
    booted,
    sid,
    sessionId,
    hasRecovery,
    resume,
    backToWorldSelect,
    replaceSessionUrl,
  ]);

  return {
    error,
    retry: () => {
      if (sid) resume(sid);
    },
  };
}
