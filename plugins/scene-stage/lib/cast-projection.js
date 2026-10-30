const MAX_CACHED_SESSIONS = 256;
const EXIT_DURATION_MS = 300;

/** Presentation history only: departed actors never return to plugin data. */
export function createCastProjection() {
  const sessions = new Map();
  return {
    clear() {
      sessions.clear();
    },
    forget(sessionId) {
      sessions.delete(sessionId);
    },
    project(sessionId, current, actors, viewpointId) {
      const previous = sessions.get(sessionId);
      const revision = JSON.stringify([current, viewpointId]);
      const now = Date.now();
      const same = previous?.revision === revision;
      const present = new Set(actors.map((actor) => actor.characterId));
      const departures = same
        ? previous.departures
        : (previous?.actors ?? [])
            .filter(
              (actor) =>
                !present.has(actor.characterId) &&
                actor.characterId !== viewpointId,
            )
            .map((actor) => ({
              ...actor,
              active: false,
              exiting: true,
              transition: "fade",
            }));
      const expiresAt = same ? previous.expiresAt : now + EXIT_DURATION_MS;
      const exiting = now < expiresAt ? departures : [];
      sessions.delete(sessionId);
      sessions.set(sessionId, {
        revision,
        actors,
        departures: exiting,
        expiresAt,
      });
      if (sessions.size > MAX_CACHED_SESSIONS)
        sessions.delete(sessions.keys().next().value);
      return [...actors, ...exiting];
    },
  };
}
