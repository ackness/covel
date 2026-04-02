import assert from "node:assert/strict";
import test from "node:test";

import { registerGracefulShutdown, SHUTDOWN_SIGNALS } from "../src/graceful-shutdown.ts";

test("registerGracefulShutdown closes the server and exits cleanly", () => {
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

  assert.deepEqual(Array.from(handlers.keys()), [...SHUTDOWN_SIGNALS]);

  handlers.get("SIGINT")?.();

  assert.equal(closeCalls, 1);
  assert.equal(closeAllConnectionsCalls, 1);
  assert.equal(exitCode, undefined);
  assert.deepEqual(logs, ["Received SIGINT, shutting down server..."]);

  closeCallback?.();

  assert.equal(exitCode, 0);
  assert.equal(clearedTimers.length, 1);
  assert.deepEqual(logs, [
    "Received SIGINT, shutting down server...",
    "Server stopped.",
  ]);
});

test("registerGracefulShutdown ignores repeated signals while shutting down", () => {
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

  assert.equal(closeCalls, 1);
});

test("registerGracefulShutdown exits with code 1 when close fails", () => {
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

  assert.equal(exitCode, 1);
  assert.deepEqual(logs, [
    "Received SIGTERM, shutting down server...",
    "Server shutdown failed: close failed",
  ]);
});
