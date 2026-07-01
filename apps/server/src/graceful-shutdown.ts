type ShutdownSignal = "SIGINT" | "SIGTERM";

export const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;

export interface ShutdownServer {
  close: (callback?: (error?: Error) => void) => unknown;
  closeAllConnections?: () => void;
}

const FORCE_EXIT_AFTER_MS = 5_000;

export const registerGracefulShutdown = (server: ShutdownServer): void => {
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

    server.close((error) => {
      clearTimeout(shutdownTimer);

      if (error) {
        console.log(`Server shutdown failed: ${error.message}`);
        process.exit(1);
        return;
      }

      console.log("Server stopped.");
      process.exit(0);
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
