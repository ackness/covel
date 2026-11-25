import process from "node:process";

type ShutdownSignal = "SIGINT" | "SIGTERM";

const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;

export interface ShutdownServer {
  close: (callback?: (error?: Error) => void) => unknown;
  closeIdleConnections?: () => void;
  closeAllConnections?: () => void;
}

export interface GracefulShutdownOptions {
  /**
   * Ordered async resource drain (audit R-11) run AFTER the HTTP server has
   * stopped accepting work and closed its connections. Socket closure does not
   * prove handler completion: drain must first stop and await application and
   * background work before closing event/store dependencies. A drain failure is
   * logged but never blocks exit; the force-exit timer bounds a hung drain.
   */
  readonly drain?: () => Promise<void>;
}

/** Overall budget: server close + resource drain, then force exit. */
const FORCE_EXIT_AFTER_MS = 10_000;
/** Grace window before upgrading closeIdleConnections() to closeAllConnections(). */
const FORCE_CLOSE_CONNECTIONS_AFTER_MS = 1_500;

export const registerGracefulShutdown = (
  server: ShutdownServer,
  options: GracefulShutdownOptions = {},
): void => {
  let shuttingDown = false;

  const shutdown = (signal: ShutdownSignal | "IPC" | "disconnect") => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.log(`[shutdown] Received ${signal}, shutting down server...`);

    let forceCloseTimer: ReturnType<typeof setTimeout> | undefined;
    const shutdownTimer = setTimeout(() => {
      console.log(
        `[shutdown] Server shutdown timed out after ${FORCE_EXIT_AFTER_MS}ms`,
      );
      process.exit(1);
    }, FORCE_EXIT_AFTER_MS);

    const finish = async (error?: Error): Promise<void> => {
      if (forceCloseTimer !== undefined) {
        clearTimeout(forceCloseTimer);
        forceCloseTimer = undefined;
      }

      const errorCode =
        error && typeof error === "object" && "code" in error
          ? (error as NodeJS.ErrnoException).code
          : undefined;
      let exitCode = 0;
      if (error && errorCode !== "ERR_SERVER_NOT_RUNNING") {
        console.error("[shutdown] Server shutdown failed:", error);
        exitCode = 1;
      } else if (error) {
        console.warn(
          "[shutdown] Server was already stopped; draining remaining resources.",
        );
      } else {
        console.log("[shutdown] Server stopped.");
      }

      if (options.drain) {
        try {
          await options.drain();
        } catch (err) {
          console.error("[shutdown] resource drain failed:", err);
        }
      }
      clearTimeout(shutdownTimer);
      process.exit(exitCode);
    };

    server.close((error) => {
      void finish(error);
    });

    if (typeof server.closeIdleConnections === "function") {
      server.closeIdleConnections();
      if (typeof server.closeAllConnections === "function") {
        forceCloseTimer = setTimeout(() => {
          server.closeAllConnections?.();
        }, FORCE_CLOSE_CONNECTIONS_AFTER_MS);
        forceCloseTimer.unref?.();
      }
    } else if (typeof server.closeAllConnections === "function") {
      server.closeAllConnections();
    }
  };

  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, () => {
      shutdown(signal);
    });
  }

  // The desktop owns this private parent-child channel. Windows kill(SIGTERM)
  // terminates abruptly, so request the same drain cooperatively over IPC.
  if (typeof process.send === "function") {
    process.once("disconnect", () => shutdown("disconnect"));
    // Bootstrap can finish after the parent has already exited. Node keeps
    // process.send on IPC children after disconnect, so do not miss that exit.
    if (!process.connected) shutdown("disconnect");
  }
  process.on("message", (message) => {
    if (
      message !== null &&
      typeof message === "object" &&
      "type" in message &&
      message.type === "covel:shutdown"
    ) {
      shutdown("IPC");
    }
  });
};
