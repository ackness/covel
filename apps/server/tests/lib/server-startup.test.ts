import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  store: vi.fn(),
  media: vi.fn(),
  pool: vi.fn(),
  bootstrap: vi.fn(),
  seed: vi.fn(),
  watcher: vi.fn(),
}));
vi.mock("@covel/store/factory", () => ({
  createStoreFromEnv: fakes.store,
  createMediaStoreFromEnv: fakes.media,
  resolveBackendFromEnv: () => "pg",
}));
vi.mock("postgres", () => ({ default: fakes.pool }));
vi.mock("../../src/ai-setup.js", () => ({
  createAiStack: () => ({ gateway: {} }),
}));
vi.mock("../../src/routes/api/bootstrap.js", () => ({
  bootstrapApi: fakes.bootstrap,
}));
vi.mock("../../src/world-seed-reconcile.js", () => ({
  seedAndReconcileWorlds: fakes.seed,
}));
vi.mock("../../src/world-file-watcher.js", () => ({
  createWorldFileWatcher: fakes.watcher,
}));

let home: string;
beforeEach(async () => {
  vi.resetModules();
  Object.values(fakes).forEach((mock) => mock.mockReset());
  home = await mkdtemp(join(tmpdir(), "covel-startup-ownership-"));
  vi.stubEnv("COVEL_HOME", home);
  vi.stubEnv("COVEL_USER_WORLDS_DIR", join(home, "user-worlds"));
  vi.stubEnv("DATABASE_URL", "postgres://fixture.invalid/test");
  vi.stubEnv("DEPLOYMENT_TIER", "self");
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

describe("production composition root startup failure", () => {
  it.each([
    "store",
    "media",
    "second-pool",
    "bootstrap",
    "world-seed",
    "second-watcher",
  ] as const)(
    "unwinds acquired resources after failure at %s and preserves its cause",
    async (phase) => {
      const failure = new Error(`failed at ${phase}`);
      const released: string[] = [];
      const close = (name: string) => async () => {
        released.push(name);
      };
      fakes.store.mockImplementation(async () => {
        if (phase === "store") throw failure;
        return { close: close("store") };
      });
      fakes.media.mockImplementation(async () => {
        if (phase === "media") throw failure;
        return { close: close("media") };
      });
      let pools = 0;
      fakes.pool.mockImplementation(() => {
        pools++;
        if (phase === "second-pool" && pools === 2) throw failure;
        return { end: close(pools === 1 ? "locks" : "ingest-locks") };
      });
      fakes.bootstrap.mockImplementation(async () => {
        if (phase === "bootstrap") throw failure;
        return {
          runtimeJobWorker: { close: close("worker") },
          pluginBackgroundQueue: { close: close("queue") },
          startupMaintenance: Promise.resolve(),
          closePluginEntries: close("entries"),
          eventBus: { close: close("bus") },
        };
      });
      fakes.seed.mockImplementation(async () => {
        if (phase === "world-seed") throw failure;
      });
      let watchers = 0;
      fakes.watcher.mockImplementation(() => {
        const index = ++watchers;
        return {
          start() {
            if (phase === "second-watcher" && index === 2) throw failure;
          },
          stop: close(`watcher-${index}`),
        };
      });
      await expect(import("../../src/app.js")).rejects.toBe(failure);
      const expected = {
        store: [],
        media: ["store"],
        "second-pool": ["media", "store", "locks"],
        bootstrap: ["media", "store", "locks", "ingest-locks"],
        "world-seed": [
          "worker",
          "queue",
          "entries",
          "bus",
          "media",
          "store",
          "locks",
          "ingest-locks",
        ],
        "second-watcher": [
          "watcher-1",
          "watcher-2",
          "worker",
          "queue",
          "entries",
          "bus",
          "media",
          "store",
          "locks",
          "ingest-locks",
        ],
      };
      expect(released).toEqual(expected[phase]);
    },
  );
});
