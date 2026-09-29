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
