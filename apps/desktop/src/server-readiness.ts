import type { ChildProcess } from "node:child_process";

/** Only this sidecar's listening acknowledgement can complete its startup. */
export function waitForServerProcess(
  child: ChildProcess,
  port: number,
  onProgress?: (elapsed: number, total: number) => void,
  timeoutMs = 30_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let progressTimer: ReturnType<typeof setInterval> | undefined;
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      clearInterval(progressTimer);
      child.removeListener("message", onMessage);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("disconnect", onDisconnect);
      if (error) reject(error);
      else resolve();
    };
    const onError = (error: Error): void => finish(error);
    const onExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      finish(
        new Error(
          `Server exited before readiness (code=${code}, signal=${signal})`,
        ),
      );
    };
    const onDisconnect = (): void =>
      finish(new Error("Server IPC disconnected before readiness"));
    const onMessage = (message: unknown): void => {
      if (
        message !== null &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "covel:ready" &&
        "port" in message &&
        message.port === port
      )
        finish();
    };
    const reportProgress = (): void => {
      try {
        onProgress?.(Date.now() - startedAt, timeoutMs);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("disconnect", onDisconnect);
    timer = setTimeout(
      () => finish(new Error(`Server did not start within ${timeoutMs}ms`)),
      timeoutMs,
    );
    progressTimer = setInterval(reportProgress, 250);
    if (child.exitCode !== null || child.signalCode !== null) {
      onExit(child.exitCode, child.signalCode);
    } else {
      reportProgress();
    }
  });
}
