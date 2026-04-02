import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  collectDescendantPids,
  runCommandWithSupervisor,
  terminateProcessTree,
} from "./dev-supervisor.mjs";

test("collectDescendantPids returns nested descendants", () => {
  const processes = [
    { pid: 10, ppid: 1 },
    { pid: 11, ppid: 10 },
    { pid: 12, ppid: 11 },
    { pid: 13, ppid: 10 },
    { pid: 20, ppid: 2 },
  ];

  assert.deepEqual(collectDescendantPids(10, processes), [12, 11, 13]);
});

test("terminateProcessTree sends SIGTERM deepest-first and avoids SIGKILL when TERM works", async () => {
  const parents = new Map([
    [200, 1],
    [201, 200],
  ]);
  const alive = new Set(parents.keys());
  const signals = [];

  await terminateProcessTree(200, {
    listProcesses: async () =>
      Array.from(alive, (pid) => ({
        pid,
        ppid: parents.get(pid) ?? 0,
      })),
    signalProcess: async (pid, signal) => {
      signals.push([pid, signal]);
      alive.delete(pid);
    },
    isProcessAlive: async (pid) => alive.has(pid),
    delay: async () => {},
    gracefulWaitMs: 0,
    forceWaitMs: 0,
    pollIntervalMs: 0,
    log: () => {},
  });

  assert.deepEqual(signals, [
    [201, "SIGTERM"],
    [200, "SIGTERM"],
  ]);
});

test("terminateProcessTree escalates to SIGKILL when SIGTERM leaves the root alive", async () => {
  const parents = new Map([
    [100, 1],
    [101, 100],
    [102, 101],
  ]);
  const alive = new Set(parents.keys());
  const signals = [];

  await terminateProcessTree(100, {
    listProcesses: async () =>
      Array.from(alive, (pid) => ({
        pid,
        ppid: parents.get(pid) ?? 0,
      })),
    signalProcess: async (pid, signal) => {
      signals.push([pid, signal]);

      if (signal === "SIGTERM" && pid !== 100) {
        alive.delete(pid);
      }

      if (signal === "SIGKILL") {
        alive.delete(pid);
      }
    },
    isProcessAlive: async (pid) => alive.has(pid),
    delay: async () => {},
    gracefulWaitMs: 0,
    forceWaitMs: 0,
    pollIntervalMs: 0,
    log: () => {},
  });

  assert.deepEqual(signals, [
    [102, "SIGTERM"],
    [101, "SIGTERM"],
    [100, "SIGTERM"],
    [100, "SIGKILL"],
  ]);
});

test("runCommandWithSupervisor returns 0 after a handled shutdown signal", async () => {
  const child = new EventEmitter();
  child.pid = 321;

  const processObject = new EventEmitter();
  processObject.env = {};
  processObject.on = processObject.addListener.bind(processObject);
  processObject.off = processObject.removeListener.bind(processObject);

  const runPromise = runCommandWithSupervisor("turbo", ["dev"], {
    spawnImpl: () => child,
    terminateProcessTreeImpl: async () => true,
    processObject,
    log: () => {},
  });

  processObject.emit("SIGINT");
  child.emit("exit", null, "SIGINT");

  assert.equal(await runPromise, 0);
});

test("runCommandWithSupervisor forwards the received signal to tree termination", async () => {
  const child = new EventEmitter();
  child.pid = 654;

  const processObject = new EventEmitter();
  processObject.env = {};
  processObject.on = processObject.addListener.bind(processObject);
  processObject.off = processObject.removeListener.bind(processObject);

  let gracefulSignal;

  const runPromise = runCommandWithSupervisor("turbo", ["dev"], {
    spawnImpl: () => child,
    terminateProcessTreeImpl: async (_pid, options) => {
      gracefulSignal = options.gracefulSignal;
      return true;
    },
    processObject,
    log: () => {},
  });

  processObject.emit("SIGTERM");
  child.emit("exit", null, "SIGTERM");

  await runPromise;

  assert.equal(gracefulSignal, "SIGTERM");
});
