import { describe, it, expect } from "vitest";

import { registerGracefulShutdown, SHUTDOWN_SIGNALS } from "../src/graceful-shutdown.ts";

describe("registerGracefulShutdown", () => {
  it("closes the server and exits cleanly", () => {
    const handlers = new Map<string, () => void>();
    const logs: string[] = [];
    const clearedTimers: unknown[] = [];
    let closeCallback: ((error?: Error) => void) | undefined;
    let closeCalls = 0;
    let closeAllConnectionsCalls = 0;
    let exitCode: number | undefined;

    registerGracefulShutdown(
      {
        close(callback) {
          closeCalls += 1;
          closeCallback = callback;
          return this;
        },
        closeAllConnections() {
          closeAllConnectionsCalls += 1;
        },
      },
      {
        on: (signal, handler) => {
          handlers.set(signal, handler);
        },
        log: (message) => {
          logs.push(message);
        },
        exit: (code) => {
          exitCode = code;
        },
        setTimer: () => Symbol("shutdown-timer"),
        clearTimer: (timer) => {
          clearedTimers.push(timer);
        },
        forceExitAfterMs: 2_000,
      },
    );

    expect(Array.from(handlers.keys())).toEqual([...SHUTDOWN_SIGNALS]);

    handlers.get("SIGINT")?.();

    expect(closeCalls).toBe(1);
    expect(closeAllConnectionsCalls).toBe(1);
    expect(exitCode).toBeUndefined();
    expect(logs).toEqual(["Received SIGINT, shutting down server..."]);

    closeCallback?.();

    expect(exitCode).toBe(0);
    expect(clearedTimers).toHaveLength(1);
    expect(logs).toEqual([
      "Received SIGINT, shutting down server...",
      "Server stopped.",
    ]);
  });

  it("ignores repeated signals while shutting down", () => {
    const handlers = new Map<string, () => void>();
    let closeCalls = 0;

    registerGracefulShutdown(
      {
        close() {
          closeCalls += 1;
          return this;
        },
      },
      {
        on: (signal, handler) => {
          handlers.set(signal, handler);
        },
        log: () => {},
        exit: () => {},
        setTimer: () => Symbol("shutdown-timer"),
        clearTimer: () => {},
      },
    );

    handlers.get("SIGINT")?.();
    handlers.get("SIGTERM")?.();

    expect(closeCalls).toBe(1);
  });

  it("exits with code 1 when close fails", () => {
    const handlers = new Map<string, () => void>();
    const logs: string[] = [];
    let closeCallback: ((error?: Error) => void) | undefined;
    let exitCode: number | undefined;

    registerGracefulShutdown(
      {
        close(callback) {
          closeCallback = callback;
          return this;
        },
      },
      {
        on: (signal, handler) => {
          handlers.set(signal, handler);
        },
        log: (message) => {
          logs.push(message);
        },
        exit: (code) => {
          exitCode = code;
        },
        setTimer: () => Symbol("shutdown-timer"),
        clearTimer: () => {},
      },
    );

    handlers.get("SIGTERM")?.();
    closeCallback?.(new Error("close failed"));

    expect(exitCode).toBe(1);
    expect(logs).toEqual([
      "Received SIGTERM, shutting down server...",
      "Server shutdown failed: close failed",
    ]);
  });
});
