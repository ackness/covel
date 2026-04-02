type ShutdownSignal = "SIGINT" | "SIGTERM";
type ShutdownTimer = unknown;

export const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;

export interface ShutdownServer {
  close: (callback?: (error?: Error) => void) => unknown;
  closeAllConnections?: () => void;
}

export interface GracefulShutdownOptions {
  on?: (signal: ShutdownSignal, listener: () => void) => void;
  log?: (message: string) => void;
  exit?: (code: number) => void;
  setTimer?: (handler: () => void, timeoutMs: number) => ShutdownTimer;
  clearTimer?: (timer: ShutdownTimer) => void;
  forceExitAfterMs?: number;
}

export const registerGracefulShutdown = (
  server: ShutdownServer,
  {
    on = (signal, listener) => {
      process.on(signal, listener);
    },
    log = (message) => {
      console.log(message);
    },
    exit = (code) => {
      process.exit(code);
    },
    setTimer = (handler, timeoutMs) => setTimeout(handler, timeoutMs),
    clearTimer = (timer) => clearTimeout(timer as NodeJS.Timeout),
    forceExitAfterMs = 5_000,
  }: GracefulShutdownOptions = {},
) => {
  let shuttingDown = false;

  const shutdown = (signal: ShutdownSignal) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    log(`Received ${signal}, shutting down server...`);

    const shutdownTimer = setTimer(() => {
      log(`Server shutdown timed out after ${forceExitAfterMs}ms`);
      exit(1);
    }, forceExitAfterMs);

    server.close((error) => {
      clearTimer(shutdownTimer);

      if (error) {
        log(`Server shutdown failed: ${error.message}`);
        exit(1);
        return;
      }

      log("Server stopped.");
      exit(0);
    });

    if (typeof server.closeAllConnections === "function") {
      server.closeAllConnections();
    }
  };

  for (const signal of SHUTDOWN_SIGNALS) {
    on(signal, () => {
      shutdown(signal);
    });
  }

  return shutdown;
};
