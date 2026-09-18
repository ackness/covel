import type { ChildProcess } from "node:child_process";

type ShutdownLog = (level: "info" | "warn", ...values: unknown[]) => void;

// Allow the server's 10-second drain budget to finish before forcing it down.
const GRACE_MS = 12_000;
const KILL_WAIT_MS = 1_000;

/** Await confirmed exit (or a failed spawn); failed termination blocks restart. */
export function stopServerProcess(
  child: ChildProcess,
  log: ShutdownLog,
): Promise<void> {
  if (
    child.pid === undefined ||
    child.exitCode !== null ||
    child.signalCode !== null
  ) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
      if (error) reject(error);
      else resolve();
    };
    const onExit = (): void => finish();
    const onError = (error: Error): void => finish(error);
    child.once("exit", onExit);
    child.once("error", onError);

    timer = setTimeout(() => {
      log("warn", "Server did not exit within 12s; sending SIGKILL");
      timer = setTimeout(
        () => finish(new Error("Server exit was not observed after SIGKILL")),
        KILL_WAIT_MS,
      );
      try {
        child.kill("SIGKILL");
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    }, GRACE_MS);

    const signalStop = (): void => {
      if (settled) return;
      log("info", "Stopping server (SIGTERM)");
      try {
        child.kill("SIGTERM");
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    if (child.connected) {
      log("info", "Stopping server (IPC)");
      try {
        child.send({ type: "covel:shutdown" }, (error) => {
          if (!error || settled) return;
          log("warn", "Shutdown IPC failed; falling back to SIGTERM:", error);
          signalStop();
        });
      } catch (error) {
        log("warn", "Shutdown IPC failed; falling back to SIGTERM:", error);
        signalStop();
      }
    } else {
      signalStop();
    }
  });
}

/** Keep Electron alive for one shared drain, then allow the re-entrant quit. */
export function createQuitHandler(
  stop: () => Promise<void>,
  quit: () => void,
  log: ShutdownLog,
): (event: { preventDefault(): void }) => void {
  let draining = false;
  let ready = false;
  return (event) => {
    if (ready) return;
    event.preventDefault();
    if (draining) return;
    draining = true;
    void Promise.resolve()
      .then(stop)
      .catch((error: unknown) => log("warn", "Server shutdown failed:", error))
      .then(() => {
        ready = true;
        quit();
      });
  };
}
