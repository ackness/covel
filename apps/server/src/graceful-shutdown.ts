type ShutdownSignal = "SIGINT" | "SIGTERM";

export const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;

export interface ShutdownServer {
  close: (callback?: (error?: Error) => void) => unknown;
  closeAllConnections?: () => void;
}

export interface GracefulShutdownOptions {
  /**
   * Ordered async resource drain (audit R-11) run AFTER the HTTP server has
   * stopped accepting work and closed its connections — flush the event bus,
   * close the DataStore / PG lock pool, stop watchers. A drain failure is
   * logged but never blocks exit; the force-exit timer bounds a hung drain.
   */
  readonly drain?: () => Promise<void>;
}

/** Overall budget: server close + resource drain, then force exit. */
const FORCE_EXIT_AFTER_MS = 10_000;

export const registerGracefulShutdown = (
  server: ShutdownServer,
  options: GracefulShutdownOptions = {},
): void => {
  let shuttingDown = false;

  const shutdown = (signal: ShutdownSignal) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.log(`Received ${signal}, shutting down server...`);

    const shutdownTimer = setTimeout(() => {
      console.log(`Server shutdown timed out after ${FORCE_EXIT_AFTER_MS}ms`);
      process.exit(1);
    }, FORCE_EXIT_AFTER_MS);

    const finish = async (error?: Error): Promise<void> => {
      if (error) {
        console.log(`Server shutdown failed: ${error.message}`);
        process.exit(1);
        return;
      }

      console.log("Server stopped.");
      if (options.drain) {
        try {
          await options.drain();
        } catch (err) {
          console.error(
            "[shutdown] resource drain failed:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      clearTimeout(shutdownTimer);
      process.exit(0);
    };

    server.close((error) => {
      void finish(error);
    });

    if (typeof server.closeAllConnections === "function") {
      server.closeAllConnections();
    }
  };

  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, () => {
      shutdown(signal);
    });
  }
};
