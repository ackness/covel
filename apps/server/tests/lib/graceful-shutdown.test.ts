import { afterEach, describe, expect, it, vi } from "vitest";
import { registerGracefulShutdown } from "../../src/graceful-shutdown.js";

const originalConnected = Object.getOwnPropertyDescriptor(process, "connected");
const originalSend = Object.getOwnPropertyDescriptor(process, "send");

const shutdownProcess = vi.hoisted(() => ({
  connected: false,
  send: undefined as (() => void) | undefined,
  on: vi.fn(),
  once: vi.fn(),
  exit: vi.fn(),
}));
vi.mock("node:process", () => ({ default: shutdownProcess }));

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function setup(drain: () => Promise<void>, connected = false, ipc = connected) {
  shutdownProcess.connected = connected;
  shutdownProcess.send = ipc ? vi.fn() : undefined;
  const listeners = new Map<string, (...args: unknown[]) => void>();
  shutdownProcess.on.mockImplementation((event, listener) => {
    listeners.set(String(event), listener);
    return shutdownProcess;
  });
  shutdownProcess.once.mockImplementation((event, listener) => {
    listeners.set(String(event), listener);
    return shutdownProcess;
  });
  const exit = shutdownProcess.exit;
  vi.spyOn(console, "log").mockImplementation(() => {});
  let finish!: (error?: Error) => void;
  const server = {
    close: vi.fn((callback?: (error?: Error) => void) => {
      finish = callback!;
    }),
    closeAllConnections: vi.fn(),
  };
  registerGracefulShutdown(server, { drain });
  return { listeners, exit, server, finish: () => finish() };
}

describe("graceful shutdown", () => {
  it("accepts private shutdown IPC, ignores unrelated messages and drains once", async () => {
    let release!: () => void;
    const drain = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const state = setup(drain);
    // The runner's IPC channel must survive the simulated desktop disconnect.
    expect(Object.getOwnPropertyDescriptor(process, "connected")).toEqual(
      originalConnected,
    );
    expect(Object.getOwnPropertyDescriptor(process, "send")).toEqual(
      originalSend,
    );
    for (const message of [
      null,
      "covel:shutdown",
      { type: "proxy-response" },
    ]) {
      state.listeners.get("message")!(message);
    }
    expect(state.server.close).not.toHaveBeenCalled();
    state.listeners.get("message")!({ type: "covel:shutdown" });
    state.listeners.get("SIGTERM")!();
    expect(state.server.close).toHaveBeenCalledOnce();
    expect(state.server.closeAllConnections).toHaveBeenCalledOnce();
    state.finish();
    expect(drain).toHaveBeenCalledOnce();
    expect(state.exit).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() =>
      expect(state.exit).toHaveBeenCalledExactlyOnceWith(0),
    );
  });

  it("drains once when its desktop parent disconnects", async () => {
    const drain = vi.fn(async () => {});
    const state = setup(drain, true);
    state.listeners.get("disconnect")!();
    state.listeners.get("message")!({ type: "covel:shutdown" });
    expect(state.server.close).toHaveBeenCalledOnce();
    state.finish();
    await vi.waitFor(() =>
      expect(state.exit).toHaveBeenCalledExactlyOnceWith(0),
    );
    expect(drain).toHaveBeenCalledOnce();
  });

  it("does not attach desktop parent lifecycle handling without IPC", () => {
    const state = setup(async () => {});
    expect(state.listeners.has("disconnect")).toBe(false);
    expect(state.server.close).not.toHaveBeenCalled();
  });

  it("drains when bootstrap finishes after its parent already disconnected", async () => {
    const drain = vi.fn(async () => {});
    const state = setup(drain, false, true);
    expect(state.server.close).toHaveBeenCalledOnce();
    state.listeners.get("disconnect")!();
    state.listeners.get("SIGTERM")!();
    state.finish();
    await vi.waitFor(() =>
      expect(state.exit).toHaveBeenCalledExactlyOnceWith(0),
    );
    expect(drain).toHaveBeenCalledOnce();
  });

  it("bounds a stuck IPC drain with the existing force-exit timer", async () => {
    vi.useFakeTimers();
    const state = setup(() => new Promise<void>(() => {}));
    state.listeners.get("message")!({ type: "covel:shutdown" });
    state.finish();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.exit).toHaveBeenCalledExactlyOnceWith(1);
  });
});
