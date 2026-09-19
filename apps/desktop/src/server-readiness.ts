import type { ChildProcess } from "node:child_process";
import { waitForServer } from "./network.js";

/** Stop readiness polling when this child fails, even if its port is reused. */
export async function waitForServerProcess(
  child: ChildProcess,
  healthUrl: string,
  onProgress?: (elapsed: number, total: number) => void,
): Promise<void> {
  let failure: Error | undefined;
  const onError = (error: Error): void => {
    failure = error;
  };
  const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    failure = new Error(
      `Server exited before readiness (code=${code}, signal=${signal})`,
    );
  };
  child.once("error", onError);
  child.once("exit", onExit);
  const assertRunning = (): void => {
    if (failure) throw failure;
    if (child.exitCode !== null || child.signalCode !== null) {
      onExit(child.exitCode, child.signalCode);
      throw failure;
    }
  };
  try {
    assertRunning();
    await waitForServer(healthUrl, 30_000, 150, (elapsed, total) => {
      assertRunning();
      onProgress?.(elapsed, total);
    });
    assertRunning();
  } finally {
    child.removeListener("error", onError);
    child.removeListener("exit", onExit);
  }
}
