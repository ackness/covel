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
        "mirror" | "memory" | "sqlite" | "pg" | "s3" | "idb" | "none";
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

/** Boot must not hang on this; a captive portal or a wedged proxy never replies. */
const HEALTH_TIMEOUT_MS = 3000;

/**
 * `/api/health` is an untrusted boundary like any other: a captive portal or an
 * intercepting proxy happily answers 200 with an HTML login page, which used to
 * surface as a bare `SyntaxError` from `res.json()` far from the cause. Check
 * the status, and treat an unparseable or non-object body as a failed probe.
 */
export async function fetchServerHealth(): Promise<ServerHealth> {
  const res = await fetch("/api/health", {
    signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`[health] HTTP ${res.status}`);
  }
  const body: unknown = await res.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("[health] response was not a JSON object");
  }
  return body as ServerHealth;
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

  let health: ServerHealth | null = null;
  try {
    health = await fetchServerHealth();
    markServerAck();
  } catch {
    // Probe failed (server still waking up, or no endpoint) — not fatal on its
    // own; fall through to a defensive sync.
  }

  // A `syncFn` rejection is NOT swallowed. It means the server has no history
  // for this session, and the kernel builds LLM context from server-side
  // messages — running the turn anyway gives the player a narrator that has
  // silently forgotten the whole story. Let the caller decide.
  if (health) {
    if (knownBootId !== null && health.bootId !== knownBootId) {
      // Server restarted — rebuild session context.
      await syncFn(sessionId);
    }
    knownBootId = health.bootId ?? null;
    return;
  }
  await syncFn(sessionId);
}
