import { afterEach, describe, expect, it, vi } from "vitest";
import { registerGracefulShutdown } from "../../src/graceful-shutdown.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function setup(drain: () => Promise<void>) {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  vi.spyOn(process, "on").mockImplementation((event, listener) => {
    listeners.set(String(event), listener);
    return process;
  });
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation(() => undefined as never);
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

  it("bounds a stuck IPC drain with the existing force-exit timer", async () => {
    vi.useFakeTimers();
    const state = setup(() => new Promise<void>(() => {}));
    state.listeners.get("message")!({ type: "covel:shutdown" });
    state.finish();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.exit).toHaveBeenCalledExactlyOnceWith(1);
  });
});
