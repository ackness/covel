// -- Server Info -------------------------------------------------

export interface ServerHealth {
  status: string;
  timestamp: string;
  version: string;
  bootId?: string;
  storage?: {
    data?: {
      backend?: "pg" | "sqlite" | "memory";
      durable?: boolean;
      frontendMode?: "local" | "remote";
    };
    media?: {
      backend?: "memory" | "sqlite" | "pg" | "s3" | "idb" | "none";
      configuredBackend?:
        | "mirror"
        | "memory"
        | "sqlite"
        | "pg"
        | "s3"
        | "idb"
        | "none";
      enabled?: boolean;
      durable?: boolean;
    };
    vector?: {
      backend?: "embedded" | "none" | "external";
      capable?: boolean;
      driver?: "in-memory" | "sqlite-vec" | "pgvector" | "external" | "none";
      modelCount?: number;
      tableCount?: number;
    };
  };
}

export async function fetchServerHealth(): Promise<ServerHealth> {
  const res = await fetch("/api/health");
  return res.json() as Promise<ServerHealth>;
}

// -- Server session sync guard ------------------------------------
//
// Render free-tier sleeps after 15 min of inactivity, wiping MemoryStore.
// Instead of syncing before every action, we use a time-gated bootId check:
//   1. Track when we last got a successful server response
//   2. If idle > STALE_THRESHOLD, ping /api/health to get bootId
//   3. If bootId changed -> server restarted -> run full sync
//
// Cost: zero overhead during normal play, one lightweight health check
// after idle periods, full sync only on actual server restart.

const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

let lastServerAckTime = 0;
let knownBootId: string | null = null;

/** Call after any successful server response to update the ack timestamp. */
export function markServerAck(): void {
  lastServerAckTime = Date.now();
}

/**
 * Ensure the server still has our session context.
 * Only checks if idle > STALE_THRESHOLD_MS. Triggers full sync on server restart.
 */
export async function ensureServerSession(
  sessionId: string,
  syncFn: (sid: string) => Promise<void>,
): Promise<void> {
  const elapsed = Date.now() - lastServerAckTime;
  if (elapsed < STALE_THRESHOLD_MS && knownBootId !== null) return;

  try {
    const health = await fetchServerHealth();
    markServerAck();

    if (knownBootId !== null && health.bootId !== knownBootId) {
      // Server restarted - rebuild session context
      await syncFn(sessionId);
    }
    knownBootId = health.bootId ?? null;
  } catch {
    // Health check failed (server still waking up?) - sync defensively
    try {
      await syncFn(sessionId);
    } catch {
      // sync also failed - let the action call surface the real error
    }
  }
}
