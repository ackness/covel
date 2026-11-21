/** Recheck cancellation after asynchronous port discovery before spawning. */
export async function findStartablePort(
  findPort: () => Promise<number>,
  isStopped: () => boolean,
): Promise<number> {
  const port = await findPort();
  if (isStopped()) throw new Error("Application is shutting down");
  return port;
}

/** Automatic recovery is owned only by a sidecar that completed readiness. */
export function createServerRecovery<Owner>(options: {
  restart: () => Promise<number>;
  navigate: (port: number) => void;
  status: (
    state: "restarting" | "up" | "down",
    attempts: number,
    delay?: number,
  ) => void;
  log: (message: string, error?: unknown) => void;
  maxAttempts?: number;
  stableMs?: number;
  retryBaseMs?: number;
}) {
  const maxAttempts = options.maxAttempts ?? 3;
  const stableMs = options.stableMs ?? 60_000;
  const retryBaseMs = options.retryBaseMs ?? 1000;
  let readyOwner: Owner | undefined;
  let attempts = 0;
  let restartTimer: NodeJS.Timeout | undefined;
  let stableTimer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;
  let generation = 0;

  function clearTimers(): void {
    if (restartTimer) clearTimeout(restartTimer);
    if (stableTimer) clearTimeout(stableTimer);
    restartTimer = undefined;
    stableTimer = undefined;
  }

  function schedule(): void {
    if (restartTimer || inFlight) return;
    if (attempts >= maxAttempts) {
      options.log(`Server exceeded ${maxAttempts} restart attempts`);
      options.status("down", attempts);
      return;
    }
    const delay = Math.min(15_000, retryBaseMs * 2 ** attempts);
    attempts++;
    const ownerGeneration = generation;
    options.status("restarting", attempts, delay);
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      inFlight = (async () => {
        try {
          const port = await options.restart();
          if (generation !== ownerGeneration || readyOwner === undefined)
            return;
          options.navigate(port);
          options.status("up", attempts);
        } catch (error) {
          if (generation !== ownerGeneration) return;
          options.log("Server restart failed", error);
        } finally {
          inFlight = undefined;
          if (generation === ownerGeneration && readyOwner === undefined)
            schedule();
        }
      })();
    }, delay);
  }

  return {
    ready(owner: Owner): void {
      readyOwner = owner;
      if (stableTimer) clearTimeout(stableTimer);
      stableTimer = setTimeout(() => {
        if (readyOwner === owner) attempts = 0;
        stableTimer = undefined;
      }, stableMs);
    },
    exited(owner: Owner): void {
      if (readyOwner !== owner) return;
      readyOwner = undefined;
      if (stableTimer) clearTimeout(stableTimer);
      stableTimer = undefined;
      schedule();
    },
    cancel(): Promise<void> {
      generation++;
      readyOwner = undefined;
      clearTimers();
      return inFlight ?? Promise.resolve();
    },
    resetBudget(): void {
      attempts = 0;
    },
  };
}

export interface HealthHeartbeatWindow {
  isDestroyed(): boolean;
  webContents: {
    send(channel: string, payload: { state: "up" | "degraded" | "down" }): void;
  };
}

/**
 * Periodic sidecar health monitor. Resets `lastHealthOk` on each fresh start
 * so a newly-ready server that crashes before its first passing poll still
 * emits `"down"`, skips destroyed windows, and ignores stale in-flight polls.
 */
export function createHealthHeartbeat(options: {
  checkHealth: (healthUrl: string) => Promise<{ ok: boolean }>;
  getWindows: () => readonly HealthHeartbeatWindow[];
  intervalMs?: number;
}) {
  const intervalMs = options.intervalMs ?? 10_000;
  let timer: NodeJS.Timeout | null = null;
  let lastHealthOk = true;
  let generation = 0;

  function broadcastStatus(state: "up" | "degraded" | "down"): void {
    for (const win of options.getWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send("covel:server:status", { state });
      }
    }
  }

  function stop(): void {
    generation++;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function start(healthUrl: string): void {
    stop();
    lastHealthOk = true;
    const activeGeneration = generation;
    timer = setInterval(() => {
      void (async () => {
        try {
          const res = await options.checkHealth(healthUrl);
          if (generation !== activeGeneration) return;
          const ok = res.ok;
          if (ok !== lastHealthOk) {
            lastHealthOk = ok;
            broadcastStatus(ok ? "up" : "degraded");
          }
        } catch {
          if (generation !== activeGeneration) return;
          if (lastHealthOk) {
            lastHealthOk = false;
            broadcastStatus("down");
          }
        }
      })();
    }, intervalMs);
  }

  return { start, stop };
}
