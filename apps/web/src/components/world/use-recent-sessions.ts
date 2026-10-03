import { useEffect, useState } from "react";
import { getDataService } from "@/services/data-service.js";
import type { SessionRecord, WorldRecord } from "@/services/api.js";

function lastTouched(session: SessionRecord): string {
  return session.updatedAt ?? session.createdAt;
}

/** The most recently touched session that can still be played, if any. */
export function latestPlayableSession(
  sessions: readonly SessionRecord[],
): SessionRecord | undefined {
  return sessions
    .filter((session) => session.status !== "ended")
    .reduce<SessionRecord | undefined>(
      (latest, session) =>
        !latest || lastTouched(session) > lastTouched(latest)
          ? session
          : latest,
      undefined,
    );
}

/** Each listed world's latest playable session, keyed by world id. */
export function recentSessionsByWorld(
  sessions: readonly SessionRecord[],
  worldIds: readonly string[],
): ReadonlyMap<string, SessionRecord> {
  const recent = new Map<string, SessionRecord>();
  for (const worldId of worldIds) {
    const latest = latestPlayableSession(
      sessions.filter((session) => session.worldId === worldId),
    );
    if (latest) recent.set(worldId, latest);
  }
  return recent;
}

/**
 * Each world's latest playable session, for a "continue" entry on the world
 * list. It is one read for all worlds; if that read fails, the list simply
 * offers no entry.
 */
export function useRecentSessions(
  worlds: readonly WorldRecord[],
  enabled: boolean,
): ReadonlyMap<string, SessionRecord> {
  const [recent, setRecent] = useState<ReadonlyMap<string, SessionRecord>>(
    () => new Map(),
  );
  const worldKey = worlds.map((world) => world.id).join("\u001f");

  useEffect(() => {
    if (!enabled || !worldKey) {
      setRecent(new Map());
      return;
    }
    let cancelled = false;
    void getDataService()
      .listSessions()
      .catch(() => [] as SessionRecord[])
      .then((sessions) => {
        if (cancelled) return;
        setRecent(recentSessionsByWorld(sessions, worldKey.split("\u001f")));
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, worldKey]);

  return recent;
}

/** Across all worlds: the session to offer as "continue where you left off". */
export function mostRecentSession(
  recent: ReadonlyMap<string, SessionRecord>,
): SessionRecord | undefined {
  return latestPlayableSession([...recent.values()]);
}
