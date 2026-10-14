### Fixed

- **Multi-pod event fan-out no longer loses events silently or grows without bound.** When a PostgreSQL NOTIFY stalls, each session queues at most 256 frames and drops the rest with a warning; the other pods see the gap and tell their clients to reload. A receiving pod keeps one ordering state per sender and session, reclaims it when the sender starts a new stream, and evicts the least recently used one, delivering any parked events and resetting clients first. Rules: `docs/reference/protocol.md`.
