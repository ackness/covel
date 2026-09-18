import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store";
import { createPluginRegistry } from "@covel/plugin-loader";
import { bootstrapApi } from "../../src/routes/api/bootstrap.js";
import { discoverAndRegisterPlugins } from "../../src/routes/api/bootstrap/plugin-discovery.js";
import { createPgEventTransport } from "../../src/lib/pg-event-transport.js";
import { createServerResourceDrain } from "../../src/server-resources.js";
import { createBootstrapPluginEntries } from "../../src/routes/api/bootstrap/plugin-entry.js";
import { createBootstrapCompactorRunner } from "../../src/routes/api/bootstrap/compactor.js";

vi.mock("../../src/routes/api/bootstrap/plugin-entry.js", async (original) => {
  const actual =
    await original<
      typeof import("../../src/routes/api/bootstrap/plugin-entry.js")
    >();
  return {
    ...actual,
    createBootstrapPluginEntries: vi.fn(actual.createBootstrapPluginEntries),
  };
});
vi.mock("../../src/routes/api/bootstrap/compactor.js", async (original) => {
  const actual =
    await original<
      typeof import("../../src/routes/api/bootstrap/compactor.js")
    >();
  return {
    ...actual,
    createBootstrapCompactorRunner: vi.fn(
      actual.createBootstrapCompactorRunner,
    ),
  };
});

vi.mock("../../src/routes/api/bootstrap/plugin-discovery.js", () => ({
  discoverAndRegisterPlugins: vi.fn(),
}));
vi.mock("../../src/lib/pg-event-transport.js", () => ({
  createPgEventTransport: vi.fn(),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("API bootstrap resource ownership", () => {
  it("disposes published entries when a later assembly step fails", async () => {
    vi.mocked(discoverAndRegisterPlugins).mockResolvedValueOnce({
      registry: createPluginRegistry(),
      discoveryMap: new Map(),
      manifestCache: new Map(),
    });
    const close = vi.fn(async () => {});
    vi.mocked(createBootstrapPluginEntries).mockResolvedValueOnce({
      close,
      ensurePluginEntry: async () => {},
      hasPendingEntry: () => false,
    });
    const failure = new Error("compactor configuration failed");
    vi.mocked(createBootstrapCompactorRunner).mockImplementationOnce(() => {
      throw failure;
    });
    const store = createMemoryStore();
    await expect(
      bootstrapApi({
        pluginsDir: "unused",
        storeBackend: "memory",
        store,
        llmAdapter: { generate: vi.fn() },
      }),
    ).rejects.toBe(failure);
    expect(close).toHaveBeenCalledOnce();
    await store.close();
  });

  it("closes an acquired transport when discovery fails and preserves the startup error", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://fixture.invalid/test");
    const failure = new Error("discovery failed");
    vi.mocked(discoverAndRegisterPlugins).mockRejectedValueOnce(failure);
    const unsubscribe = vi.fn();
    const close = vi.fn(async () => {});
    vi.mocked(createPgEventTransport).mockResolvedValueOnce({
      publish: async () => {},
      subscribe: () => unsubscribe,
      close,
    });
    const store = createMemoryStore();
    const closeStore = vi.spyOn(store, "close");
    const sweep = vi.spyOn(store, "deleteExpiredSuspensions");
    await expect(
      bootstrapApi({
        pluginsDir: "unused",
        storeBackend: "pg",
        store,
        llmAdapter: { generate: vi.fn() },
      }),
    ).rejects.toBe(failure);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(sweep).not.toHaveBeenCalled();
    // Injected resources stay owned by the composition root.
    expect(closeStore).not.toHaveBeenCalled();
    await store.close();
  });

  it("returns before startup scans finish but includes them in the host drain", async () => {
    vi.mocked(discoverAndRegisterPlugins).mockResolvedValueOnce({
      registry: createPluginRegistry(),
      discoveryMap: new Map(),
      manifestCache: new Map(),
    });
    const store = createMemoryStore();
    const release = Promise.withResolvers<number>();
    vi.spyOn(store, "deleteExpiredSuspensions").mockImplementation(
      () => release.promise,
    );
    const api = await bootstrapApi({
      pluginsDir: "unused",
      storeBackend: "memory",
      store,
      llmAdapter: { generate: vi.fn() },
    });
    const closeStore = vi.spyOn(store, "close");
    const closeBus = vi.spyOn(api.eventBus, "close");
    const closing = createServerResourceDrain({
      api,
      store,
      worldWatchers: [],
    })();
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closeStore).not.toHaveBeenCalled();
      expect(closeBus).not.toHaveBeenCalled();
    } finally {
      release.resolve(0);
      await closing;
    }
    expect(closeBus).toHaveBeenCalledOnce();
    expect(closeStore).toHaveBeenCalledOnce();
    expect(closeBus.mock.invocationCallOrder[0]).toBeLessThan(
      closeStore.mock.invocationCallOrder[0]!,
    );
  });
});
