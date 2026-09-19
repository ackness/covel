import { afterEach, describe, expect, it, vi } from "vitest";
import { createToolExecutor } from "@covel/runtime";
import { tool, z } from "@covel/tools";
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
      applicationWork: { close: close("requests") },
      runtimeJobWorker: { close: close("worker") },
      pluginBackgroundQueue: { close: close("queue") },
      startupMaintenance: Promise.resolve(),
      closePluginEntries: close("entries"),
      closeTools: close("tools"),
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
  it("retains dependencies until a cancelled tool callback releases its raw host reads", async () => {
    const { resources, calls } = fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const controller = new AbortController();
    const module = tool({
      name: "probe",
      description: "Synthetic builtin",
      parameters: z.object({}),
      async execute() {
        entered.resolve();
        await release.promise;
        calls.push("late-host-read");
        return null;
      },
    });
    const executor = createToolExecutor({ findTool: () => module });
    resources.api!.closeTools = () => executor.close();
    const running = executor.execute(
      { toolCallId: "call", name: "probe", arguments: "{}" },
      {
        sessionId: "session",
        turnId: "turn",
        pluginId: "plugin",
        runtimeId: "plugin/main",
        signal: controller.signal,
      },
    );
    await entered.promise;
    controller.abort();
    expect((await running).success).toBe(false);
    const closing = createServerResourceDrain(resources)();
    try {
      await vi.waitFor(() => expect(calls).toContain("queue"));
      expect(calls).not.toContain("entries");
      expect(calls).not.toContain("store");
    } finally {
      release.resolve();
      await closing;
    }
    expect(calls.indexOf("late-host-read")).toBeLessThan(
      calls.indexOf("store"),
    );
    expect(calls).toContain("store");
  });

  it("stops background lock owners before waiting for foreground and watcher work", async () => {
    const { resources, calls } = fixture();
    const stopped = Promise.withResolvers<void>();
    resources.api!.applicationWork.close = () => stopped.promise;
    resources.worldWatchers[0]!.stop = () => stopped.promise;
    resources.api!.pluginBackgroundQueue.close = async () => {
      stopped.resolve();
    };
    await createServerResourceDrain(resources)();
    expect(calls).toContain("store");
  });

  it("drains startup scans before closing dependencies and is idempotent", async () => {
    const { resources, calls } = fixture();
    const scan = Promise.withResolvers<void>();
    resources.api = { ...resources.api!, startupMaintenance: scan.promise };
    const drain = createServerResourceDrain(resources);
    const closing = drain();
    expect(drain()).toBe(closing);
    try {
      await vi.waitFor(() => expect(calls).toContain("queue"));
      expect(calls).toEqual([
        "requests",
        "watchers",
        "worker",
        "queue",
        "tools",
      ]);
    } finally {
      scan.resolve();
      await closing;
    }
    expect(calls).toEqual([
      "requests",
      "watchers",
      "worker",
      "queue",
      "tools",
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
    expect(calls).toEqual(["requests", "watchers", "worker", "queue", "tools"]);
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
      "requests",
      "watchers",
      "worker",
      "queue",
      "tools",
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
