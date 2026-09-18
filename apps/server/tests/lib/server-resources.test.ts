import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createServerResourceDrain,
  type ServerResources,
} from "../../src/server-resources.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function fixture() {
  const calls: string[] = [];
  const close = (name: string) =>
    vi.fn(async () => {
      calls.push(name);
    });
  const resources: ServerResources = {
    worldWatchers: [{ start() {}, stop: close("watchers") }],
    api: {
      runtimeJobWorker: { close: close("worker") },
      pluginBackgroundQueue: { close: close("queue") },
      startupMaintenance: Promise.resolve(),
      closePluginEntries: close("entries"),
      eventBus: { close: close("bus") },
    },
    store: { close: close("store") },
    mediaStore: { close: close("media") },
    lockSql: { end: close("locks") },
    ingestLockSql: { end: close("ingest-locks") },
  };
  return { resources, calls };
}

describe("server resource ownership", () => {
  it("drains startup scans before closing dependencies and is idempotent", async () => {
    const { resources, calls } = fixture();
    const scan = Promise.withResolvers<void>();
    resources.api = { ...resources.api!, startupMaintenance: scan.promise };
    const drain = createServerResourceDrain(resources);
    const closing = drain();
    expect(drain()).toBe(closing);
    try {
      await vi.waitFor(() => expect(calls).toContain("queue"));
      expect(calls).toEqual(["watchers", "worker", "queue"]);
    } finally {
      scan.resolve();
      await closing;
    }
    expect(calls).toEqual([
      "watchers",
      "worker",
      "queue",
      "entries",
      "bus",
      "media",
      "store",
      "locks",
      "ingest-locks",
    ]);
  });

  it("closes only resources acquired before a partial startup failure", async () => {
    const closeStore = vi.fn(async () => {});
    const drain = createServerResourceDrain({
      worldWatchers: [],
      store: { close: closeStore },
    });
    await drain();
    expect(closeStore).toHaveBeenCalledOnce();
  });

  it("retains dependencies when a producer exceeds the shutdown budget", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { resources, calls } = fixture();
    const scan = Promise.withResolvers<void>();
    resources.api = { ...resources.api!, startupMaintenance: scan.promise };
    const closing = createServerResourceDrain(resources)();
    await vi.advanceTimersByTimeAsync(2_000);
    await closing;
    expect(calls).toEqual(["watchers", "worker", "queue"]);
    // A late settlement does not independently close dependencies after return.
    scan.resolve();
    await Promise.resolve();
    expect(calls).not.toContain("store");
  });

  it("continues disposing independent leaves without logging raw failure content", async () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { resources, calls } = fixture();
    resources.mediaStore = {
      close: async () => {
        throw new Error("private-connection-details");
      },
    };
    await createServerResourceDrain(resources)();
    expect(calls).toEqual([
      "watchers",
      "worker",
      "queue",
      "entries",
      "bus",
      "store",
      "locks",
      "ingest-locks",
    ]);
    expect(log).toHaveBeenCalledWith(
      '[shutdown] drain phase "close media store" failed or timed out',
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(
      "private-connection-details",
    );
  });

  it("publishes the drain promise before a disposer re-enters it", async () => {
    const { resources } = fixture();
    const drain = createServerResourceDrain(resources);
    let reentrant: Promise<void> | undefined;
    resources.worldWatchers[0]!.stop = async () => {
      reentrant = drain();
    };
    const closing = drain();
    await closing;
    expect(reentrant).toBe(closing);
  });
});
