import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { test } from "node:test";
import { createQuitHandler, stopServerProcess } from "./server-shutdown.js";
import { waitForServerProcess } from "./server-readiness.js";

function fakeChild(
  kill: (signal?: NodeJS.Signals | number) => boolean,
  exitCode: number | null = null,
): ChildProcess {
  return Object.assign(new EventEmitter(), {
    pid: 12345,
    exitCode,
    signalCode: null,
    kill,
  }) as unknown as ChildProcess;
}

const log = (): void => {};

await test("a failed spawn is reported by readiness instead of an unhandled error event", async () => {
  const child = spawn(process.execPath, ["-e", ""], {
    cwd: new URL("./missing-startup-fixture/", import.meta.url),
    stdio: "ignore",
  });
  await assert.rejects(
    waitForServerProcess(child, "http://127.0.0.1:0/health"),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "ENOENT",
  );
  assert.equal(child.listenerCount("error"), 0);
  // A failed spawn has no OS process and emits no exit to wait for.
  await stopServerProcess(child, log);
});

await test("an already exited sidecar cannot become ready from an unrelated health response", async () => {
  const child = fakeChild(() => true, 1);
  await assert.rejects(
    waitForServerProcess(child, "http://127.0.0.1:0/health"),
    /exited before readiness/,
  );
});

await test("waits for a real sidecar to finish its IPC drain", async (t) => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
    setInterval(() => {}, 1000);
    process.on("message", (message) => {
      if (message.type === "covel:shutdown") setTimeout(() => process.exit(0), 30);
    });
    process.stdout.write("ready");
  `,
    ],
    { stdio: ["ignore", "pipe", "ignore", "ipc"] },
  );
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  await once(child.stdout!, "data");
  await stopServerProcess(child, log);
  assert.equal(child.exitCode, 0);
  assert.equal(child.signalCode, null);
});

await test("an IPC failure falls back to a signal and still waits for exit", async () => {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const child = Object.assign(
    fakeChild((signal) => {
      signals.push(signal);
      return true;
    }),
    {
      connected: true,
      send: (_message: unknown, callback: (error: Error) => void) => {
        callback(new Error("synthetic IPC failure"));
      },
    },
  );
  const stopped = stopServerProcess(child, log);
  assert.deepEqual(signals, ["SIGTERM"]);
  child.emit("exit", 0, null);
  await stopped;
});

await test("escalates after the grace budget but still waits for observed exit", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const child = fakeChild((signal) => {
    signals.push(signal);
    return true;
  });
  let stopped = false;
  const pending = stopServerProcess(child, log).then(() => {
    stopped = true;
  });
  assert.deepEqual(signals, ["SIGTERM"]);
  t.mock.timers.tick(12_000);
  await Promise.resolve();
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(stopped, false);
  child.emit("exit", null, "SIGKILL");
  await pending;
  assert.equal(child.listenerCount("exit"), 0);
  assert.equal(child.listenerCount("error"), 0);
});

await test("rejects an unconfirmed termination instead of allowing a second server", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const child = fakeChild(() => false);
  const rejected = assert.rejects(
    stopServerProcess(child, log),
    /not observed/,
  );
  t.mock.timers.tick(12_000);
  t.mock.timers.tick(1_000);
  await rejected;
  assert.equal(child.listenerCount("exit"), 0);
});

await test("preserves a synchronous signal error and clears listeners and timers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const failure = new Error("synthetic kill failure");
  let attempts = 0;
  const child = fakeChild(() => {
    attempts++;
    throw failure;
  });
  await assert.rejects(
    stopServerProcess(child, log),
    (error) => error === failure,
  );
  t.mock.timers.tick(20_000);
  assert.equal(attempts, 1);
  assert.equal(child.listenerCount("exit"), 0);
  assert.equal(child.listenerCount("error"), 0);
});

await test("rejects an error event because it does not prove the child exited", async () => {
  const child = fakeChild(() => true);
  const rejected = assert.rejects(
    stopServerProcess(child, log),
    /signal denied/,
  );
  child.emit("error", new Error("signal denied"));
  await rejected;
});

await test("an already exited child needs no new signal", async () => {
  const child = fakeChild(() => {
    throw new Error("must not signal");
  }, 0);
  await stopServerProcess(child, log);
});

await test("quit waits for one shared drain and permits the final re-entry", async () => {
  let release!: () => void;
  const drain = new Promise<void>((resolve) => {
    release = resolve;
  });
  let stops = 0;
  let quits = 0;
  let prevented = 0;
  const event = {
    preventDefault: () => {
      prevented++;
    },
  };
  const handler = createQuitHandler(
    () => {
      stops++;
      return drain;
    },
    () => {
      quits++;
      handler(event);
    },
    log,
  );
  handler(event);
  handler(event);
  await Promise.resolve();
  assert.equal(stops, 1);
  assert.equal(quits, 0);
  release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(quits, 1);
  assert.equal(prevented, 2);
});

await test("quit reports a drain failure and still finishes", async () => {
  let warned = false;
  let quit = false;
  createQuitHandler(
    async () => {
      throw new Error("synthetic drain failure");
    },
    () => {
      quit = true;
    },
    () => {
      warned = true;
    },
  )({ preventDefault() {} });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(warned, true);
  assert.equal(quit, true);
});
